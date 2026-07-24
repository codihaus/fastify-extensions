import type { FastifyInstance } from 'fastify';
import type {
	ExtensionConfig,
	ExtensionLoggerLike,
	ExtensionManifest,
	LoadedExtension,
	ScheduleLock,
	ServiceRegistry,
} from './types.js';
import { Emitter } from './emitter.js';
import { ServiceRegistryImpl } from './registry.js';
import { MemoryScheduleLock } from './schedule.js';
import { createConsoleLogger } from './logger.js';
import {
	scanLocalExtensions,
	scanModuleExtensions,
	validateManifest,
} from './discovery.js';
import {
	importExtensionModule,
	readExtensionPackage,
	registerModuleEndpoints,
	registerModuleHooks,
} from './loader.js';

/** The init event during which extensions provide cross-extension services. */
const REGISTER_EVENT = 'extensions.register';

/** Options for constructing an {@link ExtensionManager}. */
export interface ExtensionManagerOptions<TContext> {
	/** Key in an extension's package.json that marks it as an extension, e.g. `"myapp-extension"`. REQUIRED. */
	manifestKey: string;

	/** Absolute or cwd-relative path to a local extensions directory. Omit to skip the local scan. */
	extensionsPath?: string;

	/**
	 * Directory containing the host package.json used to discover npm-dependency extensions.
	 * Defaults to `process.cwd()`. Set `false` to disable module scanning.
	 */
	moduleRoot?: string | false;

	/** Extension ids that MUST load successfully; Phase 1 throws otherwise. Default: `[]`. */
	mustLoad?: string[];

	/** Minimal logger. Default: a console-backed fallback. */
	logger?: ExtensionLoggerLike;

	/**
	 * The event emitter extensions attach to. Default: the manager creates and owns its own
	 * {@link Emitter}. Hosts that emit their own events should construct the Emitter and pass it in.
	 */
	emitter?: Emitter<any>;

	/** Async enable check per extension id. Default: always enabled. */
	isEnabled?: (id: string) => Promise<boolean> | boolean;

	/**
	 * Called once per loaded extension (Phase 2) with the raw package.json and the config.
	 * Errors thrown here are logged per-extension, not fatal.
	 */
	onManifest?: (pkg: Record<string, unknown>, config: ExtensionConfig) => void | Promise<void>;

	/** Builds the context injected into each extension. Called once per extension. REQUIRED. */
	createContext: (config: ExtensionConfig) => TContext;

	/** Multi-instance lock for cron schedules. Only used when the manager owns the emitter. Default: in-memory. */
	scheduleLock?: ScheduleLock;
}

/** A module loaded in Phase 1 awaiting endpoint registration in Phase 2. */
interface PendingExtension<TContext> {
	config: ExtensionConfig;
	manifest: ExtensionManifest;
	module: Record<string, unknown>;
	pkg: Record<string, unknown> | null;
	context: TContext;
	hookCleanupFns: Array<() => void | Promise<void>>;
}

/**
 * Manager lifecycle. Transitions:
 * `idle` --scanAndLoadHooks--> `hooks-loaded` --loadEndpoints--> `ready` --reset--> `idle`.
 * Calling a phase method from the wrong state throws, so repeated Phase 1 runs can
 * never silently double-register hooks and a failed/finished load sequence can only
 * be retried via a full `reset()`.
 */
type ManagerPhase = 'idle' | 'hooks-loaded' | 'ready';

/**
 * Manifest-based extension system for Fastify.
 *
 * A microkernel that discovers extension packages (local directory + npm dependencies),
 * loads them in two phases (hooks before the server exists, endpoints after), injects a
 * host-defined `TContext` into each, and coordinates a shared event emitter and a
 * cross-extension service registry.
 */
export class ExtensionManager<TContext> {
	private readonly manifestKey: string;
	private readonly extensionsPath: string | undefined;
	private readonly moduleRoot: string | false;
	private readonly mustLoad: string[];
	private readonly logger: ExtensionLoggerLike;
	private readonly isEnabled: (id: string) => Promise<boolean> | boolean;
	private readonly onManifest: ((pkg: Record<string, unknown>, config: ExtensionConfig) => void | Promise<void>) | undefined;
	private readonly createContext: (config: ExtensionConfig) => TContext;

	private readonly emitterInstance: Emitter<unknown>;
	private readonly ownsEmitter: boolean;
	private readonly registryInstance: ServiceRegistryImpl;

	private readonly loadedExtensions = new Map<string, LoadedExtension>();
	private readonly pendingExtensions = new Map<string, PendingExtension<TContext>>();
	private phase: ManagerPhase = 'idle';

	constructor(options: ExtensionManagerOptions<TContext>) {
		if (!options.manifestKey) {
			throw new Error('ExtensionManager requires a non-empty "manifestKey" option.');
		}
		if (typeof options.createContext !== 'function') {
			throw new Error('ExtensionManager requires a "createContext" function.');
		}

		this.manifestKey = options.manifestKey;
		this.extensionsPath = options.extensionsPath;
		this.moduleRoot = options.moduleRoot ?? process.cwd();
		this.mustLoad = options.mustLoad ?? [];
		this.logger = options.logger ?? createConsoleLogger({ name: 'extensions' });
		this.isEnabled = options.isEnabled ?? (() => true);
		this.onManifest = options.onManifest;
		this.createContext = options.createContext;

		this.ownsEmitter = options.emitter === undefined;
		this.emitterInstance =
			options.emitter ??
			new Emitter({ logger: this.logger, scheduleLock: options.scheduleLock ?? new MemoryScheduleLock() });

		this.registryInstance = new ServiceRegistryImpl(this.logger);
	}

	/** The shared event emitter (owned by the manager unless one was injected). */
	get emitter(): Emitter<unknown> {
		return this.emitterInstance;
	}

	/** The cross-extension service registry for this manager instance. */
	get registry(): ServiceRegistry {
		return this.registryInstance;
	}

	/**
	 * Discovery only — scan the local directory and npm dependencies without loading.
	 * Local extensions win over module extensions on an id collision. Within one
	 * source, a duplicate id keeps the FIRST candidate (local scan order is
	 * alphabetical; module order follows the host's dependency declaration) and logs
	 * an error for each ignored duplicate.
	 */
	async scanExtensions(): Promise<ExtensionConfig[]> {
		const localScan = this.extensionsPath !== undefined
			? scanLocalExtensions(this.extensionsPath, this.manifestKey, this.logger)
			: Promise.resolve<ExtensionConfig[]>([]);
		const moduleScan = this.moduleRoot !== false
			? scanModuleExtensions(this.moduleRoot, this.manifestKey, this.logger)
			: Promise.resolve<ExtensionConfig[]>([]);

		const [localConfigs, moduleConfigs] = await Promise.all([localScan, moduleScan]);

		const uniqueLocalConfigs = this.dedupeWithinSource(localConfigs, 'local');
		const uniqueModuleConfigs = this.dedupeWithinSource(moduleConfigs, 'module');

		const localIds = new Set(uniqueLocalConfigs.map((config) => config.id));
		const crossDeduped = uniqueModuleConfigs.filter((config) => !localIds.has(config.id));

		return [...uniqueLocalConfigs, ...crossDeduped];
	}

	/** Keep the first config per id, log an error for every ignored duplicate. */
	private dedupeWithinSource(configs: ExtensionConfig[], source: 'local' | 'module'): ExtensionConfig[] {
		const seenIds = new Map<string, ExtensionConfig>();
		for (const config of configs) {
			const existing = seenIds.get(config.id);
			if (existing) {
				this.logger.error(
					{ id: config.id, kept: existing.folder, ignored: config.folder, source },
					`Duplicate extension id "${config.id}" in ${source} scan — keeping "${existing.folder}", ignoring "${config.folder}"`,
				);
				continue;
			}
			seenIds.set(config.id, config);
		}
		return Array.from(seenIds.values());
	}

	/**
	 * Phase 1 — discover extensions and register their hooks. No Fastify instance needed.
	 * Single-shot: calling it again without an intervening `reset()` throws, so hooks
	 * can never be silently double-registered.
	 */
	async scanAndLoadHooks(): Promise<void> {
		if (this.phase !== 'idle') {
			throw new Error(
				`scanAndLoadHooks() called in phase "${this.phase}" — it may only run once per load cycle; call reset() first to reload.`,
			);
		}

		const configs = await this.scanExtensions();

		for (const config of configs) {
			let enabled: boolean;
			try {
				enabled = await this.isEnabled(config.id);
			} catch (error) {
				this.logger.warn({ id: config.id, error }, 'isEnabled check failed, treating extension as enabled');
				enabled = true;
			}

			if (!enabled) {
				this.logger.debug({ id: config.id }, 'Extension disabled, skipping');
				continue;
			}

			try {
				await this.loadExtensionHooks(config);
			} catch (error) {
				this.logger.error({ id: config.id, error }, 'Failed to load extension hooks in Phase 1');
			}
		}

		this.phase = 'hooks-loaded';

		for (const requiredId of this.mustLoad) {
			if (!this.pendingExtensions.has(requiredId)) {
				throw new Error(`Required extension "${requiredId}" failed to load. Cannot start server.`);
			}
		}
	}

	/**
	 * Phase 2 — mount endpoint extensions, emit the register event, seal the registry.
	 *
	 * One-shot: requires Phase 1 to have run and may not run twice; retrying after a
	 * failure requires a full `reset()`. If an `extensions.register` init handler
	 * throws, the error propagates to the caller (boot should fail loudly), but the
	 * registry is still sealed and the manager still reaches its terminal `ready`
	 * phase — so an accidental second call cannot re-fire init side effects.
	 *
	 * An extension whose endpoint setup throws is NOT reported as loaded: its hook
	 * cleanups run and it is discarded (error logged, other extensions continue).
	 * Routes it mounted before throwing cannot be removed from Fastify — a partial
	 * mount is possible and is logged as such.
	 */
	async loadEndpoints(app: FastifyInstance): Promise<void> {
		if (this.phase === 'idle') {
			throw new Error('loadEndpoints() called before scanAndLoadHooks() — run Phase 1 first.');
		}
		if (this.phase === 'ready') {
			throw new Error('loadEndpoints() already ran — call reset() before loading again.');
		}

		for (const [id, pending] of this.pendingExtensions) {
			try {
				await registerModuleEndpoints(pending.module, pending.config, pending.manifest, app, pending.context);
			} catch (error) {
				this.logger.error(
					{ id, error },
					'Failed to register extension endpoints in Phase 2 — extension discarded (routes mounted before the failure, if any, remain)',
				);
				await runCleanups(pending.hookCleanupFns);
				continue;
			}

			if (this.onManifest) {
				try {
					await this.onManifest(pending.pkg ?? {}, pending.config);
				} catch (error) {
					this.logger.warn({ id, error }, 'onManifest callback threw, ignoring');
				}
			}

			this.loadedExtensions.set(id, {
				config: pending.config,
				cleanupFns: pending.hookCleanupFns,
			});
			this.logger.info({ id, folder: pending.config.folder }, 'Extension loaded');
		}

		this.pendingExtensions.clear();

		try {
			await this.emitterInstance.emitInit(REGISTER_EVENT);
		} finally {
			this.registryInstance.seal();
			this.phase = 'ready';
		}
	}

	/** Loaded extension configs. */
	getExtensions(): ExtensionConfig[] {
		return Array.from(this.loadedExtensions.values()).map((loaded) => loaded.config);
	}

	/** A single loaded extension, or undefined if unknown. */
	getExtension(id: string): LoadedExtension | undefined {
		return this.loadedExtensions.get(id);
	}

	/**
	 * Run all cleanup functions of one extension and forget it. Returns false for an
	 * unknown id. Note: this does NOT un-import the ESM module (impossible) and cannot
	 * unregister already-mounted Fastify routes.
	 */
	async unloadExtension(id: string): Promise<boolean> {
		const loaded = this.loadedExtensions.get(id);
		if (!loaded) {
			return false;
		}

		await runCleanups(loaded.cleanupFns);
		this.loadedExtensions.delete(id);
		return true;
	}

	/**
	 * Clean up everything: run (and await) all cleanups, clear state, reset the
	 * registry, stop schedules if the manager owns the emitter. Returns the manager
	 * to the `idle` phase so a fresh load cycle may start.
	 */
	async reset(): Promise<void> {
		for (const loaded of this.loadedExtensions.values()) {
			await runCleanups(loaded.cleanupFns);
		}
		for (const pending of this.pendingExtensions.values()) {
			await runCleanups(pending.hookCleanupFns);
		}

		this.loadedExtensions.clear();
		this.pendingExtensions.clear();
		this.registryInstance.reset();

		if (this.ownsEmitter) {
			await this.emitterInstance.stopAllSchedules();
		}

		this.phase = 'idle';
	}

	/** Load hooks for a single extension (Phase 1). */
	private async loadExtensionHooks(config: ExtensionConfig): Promise<void> {
		const pkg = await readExtensionPackage(config);
		if (!pkg) {
			throw new Error(`Could not read package.json for extension "${config.id}"`);
		}

		const validation = validateManifest(pkg[this.manifestKey]);
		if (!validation.ok) {
			throw new Error(`Invalid manifest for extension "${config.id}": ${validation.errors.join(', ')}`);
		}
		const manifest = validation.manifest;

		const module = await importExtensionModule(config, manifest, pkg, this.logger);
		const context = this.createContext(config);
		const hookCleanupFns = await registerModuleHooks(module, config, manifest, this.emitterInstance, context, this.logger);

		if (hookCleanupFns === null) {
			// Unrecognized module shape — skipped, never tracked as pending or loaded.
			return;
		}

		this.pendingExtensions.set(config.id, {
			config,
			manifest,
			module,
			pkg,
			context,
			hookCleanupFns,
		});
	}
}

/**
 * Run cleanup functions in REVERSE registration order (later registrations may
 * depend on earlier ones), awaiting each and swallowing individual errors.
 */
async function runCleanups(cleanupFns: Array<() => void | Promise<void>>): Promise<void> {
	for (let index = cleanupFns.length - 1; index >= 0; index -= 1) {
		try {
			await cleanupFns[index]?.();
		} catch {
			// Ignore cleanup errors.
		}
	}
}
