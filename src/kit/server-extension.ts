import type { FastifyInstance, FastifyListenOptions, FastifyPluginAsync } from 'fastify';
import { ExtensionManager } from '../kernel/manager.js';
import type { Emitter } from '../runtime/emitter.js';
import type { ExtensionConfig, ExtensionLoggerLike, ServiceRegistry } from '../types.js';
import { createHealthProbe } from './health.js';
import {
	acceptEmptyJsonBody,
	defaultErrorHandler,
	defaultNotFoundHandler,
	echoRequestId,
	resolveFastifyOptions,
} from './http-defaults.js';
import type { AppKitBaseContext, AppKitOptions, AppKitState } from './options.js';
import { ShutdownRegistry, type ShutdownPhase } from './shutdown.js';
import { registerView } from './view.js';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Batteries-included app kit on top of {@link ExtensionManager} and Fastify.
 *
 * `ServerExtension.start(options)` builds and starts a full app in one call, with the
 * ODP core boot order:
 *
 * 1. create Fastify (kit defaults + `options.fastify`), health / request-id hooks
 * 2. Phase 1 — discover extensions, register their hooks
 * 3. `options.services` → `extensions.register` → registry sealed → view engine
 * 4. init `app.before` → `options.plugins` → init `middlewares.before` →
 *    `options.middlewares` → init `middlewares.after`
 * 5. init `routes.before` → `options.routes` → Phase 2 extension endpoints → init `routes.after`
 * 6. init `app.after` → `app.ready()` → `options.onReady`
 * 7. `start()` only: listen → action `server.start`; SIGINT/SIGTERM → graceful close
 *
 * Close (via {@link close}, a signal, or `app.close()`): action `server.stop` →
 * Fastify drains in-flight requests → shutdown hooks phase by phase
 * (`workers` → `schedules` [extension cleanup + cron stop] → `connections` [`onClose`]).
 *
 * Use {@link create} in tests: the same app, without a TCP port (`kit.app.inject`).
 */
export class ServerExtension<TContext = AppKitBaseContext> {
	readonly name: string;
	readonly app: FastifyInstance;
	readonly manager: ExtensionManager<TContext>;

	private stateValue: AppKitState = 'building';
	private addressValue: string | undefined;
	private readonly shutdown: ShutdownRegistry;
	private closePromise: Promise<void> | undefined;
	private removeSignalHandlers: (() => void) | undefined;

	private constructor(name: string, app: FastifyInstance, options: AppKitOptions<TContext>) {
		this.name = name;
		this.app = app;
		this.shutdown = new ShutdownRegistry(app.log, options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);

		const logger = app.log.child({ module: 'extensions' }) as unknown as ExtensionLoggerLike;
		const extensions = options.extensions || undefined;
		const buildContext = options.context;

		this.manager = new ExtensionManager<TContext>({
			manifestKey: extensions?.manifestKey ?? `${name}-extension`,
			extensionsPath: extensions?.extensionsPath,
			moduleRoot: extensions ? extensions.moduleRoot : false,
			mustLoad: extensions?.mustLoad,
			isEnabled: extensions?.isEnabled,
			onManifest: extensions?.onManifest,
			scheduleLock: extensions?.scheduleLock,
			logger,
			createContext: (config) => {
				const base: AppKitBaseContext = {
					extensionId: config.id,
					appName: name,
					config,
					logger: logger.child({ extension: config.id }),
					emitter: this.manager.emitter,
					registry: this.manager.registry,
					onShutdown: (phase, hookName, run) => this.onShutdown(phase, `${config.id}:${hookName}`, run),
				};
				return buildContext ? buildContext(base) : (base as TContext);
			},
		});

		// Extension hooks, actions, inits and cron jobs stop with the other schedules.
		this.onShutdown('schedules', 'extensions', () => this.manager.reset());
		if (options.onClose) {
			const onClose = options.onClose;
			this.onShutdown('connections', 'onClose', () => onClose(this));
		}

		// Runs for kit.close() and for a direct app.close() alike.
		app.addHook('onClose', async () => {
			this.stateValue = 'closing';
			await this.shutdown.run();
			this.stateValue = 'closed';
		});
	}

	/** The shared event emitter. */
	get emitter(): Emitter<unknown> {
		return this.manager.emitter;
	}

	/** The cross-extension service registry. */
	get registry(): ServiceRegistry {
		return this.manager.registry;
	}

	/** The Fastify logger. */
	get logger(): FastifyInstance['log'] {
		return this.app.log;
	}

	/** Current lifecycle state. */
	get state(): AppKitState {
		return this.stateValue;
	}

	/** Listen address once {@link listen} resolved. */
	get address(): string | undefined {
		return this.addressValue;
	}

	/** Loaded extension configs. */
	get extensions(): ExtensionConfig[] {
		return this.manager.getExtensions();
	}

	/**
	 * Build the app without listening. The returned kit is `ready`: every plugin,
	 * route and extension is mounted. A boot failure closes the app (stopping any
	 * extension schedule already started) and rethrows.
	 */
	static async create<TContext = AppKitBaseContext>(
		options: AppKitOptions<TContext> = {},
	): Promise<ServerExtension<TContext>> {
		const { default: Fastify } = await import('fastify');
		const app = Fastify(resolveFastifyOptions(options.fastify, options.requestId !== false));
		const kit = new ServerExtension<TContext>(options.name ?? 'app', app, options);

		try {
			await kit.boot(options);
		} catch (error) {
			app.log.error({ err: error }, 'App boot failed');
			try {
				await app.close();
			} catch {
				// The boot error is the one worth reporting.
			}
			await kit.shutdown.run();
			kit.stateValue = 'closed';
			throw error;
		}

		return kit;
	}

	/**
	 * Build the app, listen, and install signal handlers for graceful shutdown.
	 *
	 * @example
	 * await ServerExtension.start({
	 *   name: 'orders',
	 *   port: 3000,
	 *   extensions: { manifestKey: 'orders-extension', extensionsPath: './extensions' },
	 *   routes: (app) => { app.get('/', async () => ({ ok: true })); },
	 * });
	 */
	static async start<TContext = AppKitBaseContext>(
		options: AppKitOptions<TContext> = {},
	): Promise<ServerExtension<TContext>> {
		const kit = await ServerExtension.create(options);

		try {
			await kit.listen({ port: options.port ?? 3000, host: options.host ?? '127.0.0.1', ...options.listen });
		} catch (error) {
			kit.app.log.error({ err: error }, 'App failed to listen');
			await kit.close('listen-failed');
			throw error;
		}

		if (options.signals !== false) {
			kit.handleSignals(options.signals ?? ['SIGINT', 'SIGTERM'], options.exitOnSignal ?? true);
		}

		return kit;
	}

	/** Listen and emit the `server.start` action. Returns the address. */
	async listen(options: FastifyListenOptions = {}): Promise<string> {
		if (this.stateValue !== 'ready') {
			throw new Error(`listen() called in state "${this.stateValue}" — the kit can listen once, after create().`);
		}

		const address = await this.app.listen(options);
		this.addressValue = address;
		this.stateValue = 'listening';
		this.app.log.info({ address, app: this.name }, 'App listening');
		this.emitter.emitAction('server.start', { address, port: options.port, host: options.host }, undefined);
		return address;
	}

	/**
	 * Register a resource to release on shutdown. Hooks of one phase run in parallel;
	 * a hook that throws or outlives `shutdownTimeoutMs` is logged and skipped.
	 * Returns a function that unregisters the hook.
	 */
	onShutdown(phase: ShutdownPhase, name: string, run: () => void | Promise<void>): () => void {
		return this.shutdown.add(phase, name, run);
	}

	/**
	 * Graceful shutdown. Idempotent: every call returns the same promise. Emits the
	 * `server.stop` action, then closes Fastify, which runs the shutdown hooks.
	 */
	close(reason = 'close'): Promise<void> {
		this.closePromise ??= this.runClose(reason);
		return this.closePromise;
	}

	private async runClose(reason: string): Promise<void> {
		this.removeSignalHandlers?.();
		this.stateValue = 'closing';
		this.emitter.emitAction('server.stop', { reason }, undefined);
		try {
			await this.app.close();
		} catch (error) {
			this.app.log.error({ err: error }, 'Error while closing the app');
			await this.shutdown.run();
		}
		this.stateValue = 'closed';
		this.app.log.info({ app: this.name, reason }, 'App closed');
	}

	private async boot(options: AppKitOptions<TContext>): Promise<void> {
		const app = this.app;
		const emitter = this.emitter;

		if (options.acceptEmptyJson !== false) {
			acceptEmptyJsonBody(app);
		}
		if (options.requestId !== false) {
			echoRequestId(app);
		}
		if (options.health !== false) {
			const isServing = () => this.stateValue === 'ready' || this.stateValue === 'listening';
			app.addHook('onRequest', createHealthProbe(options.health === true ? {} : options.health ?? {}, isServing, app.log));
		}
		// Set before any plugin or route so every child scope inherits them.
		if (options.errorHandler !== false) {
			app.setErrorHandler(options.errorHandler ?? defaultErrorHandler);
		}
		if (options.notFoundHandler !== false) {
			app.setNotFoundHandler(options.notFoundHandler ?? defaultNotFoundHandler);
		}

		// Phase 1 — hooks exist before any init event fires.
		await this.manager.scanAndLoadHooks();

		// Phase 1.5 — host services, then extension providers; the registry seals here.
		await options.services?.(this.registry, this);
		await this.manager.registerServices();

		if (options.view !== false) {
			await registerView(app, options.view ?? {});
		}

		await emitter.emitInit('app.before', { app });

		for (const entry of options.plugins ?? []) {
			const [plugin, pluginOptions] = Array.isArray(entry) ? entry : [entry, undefined];
			await app.register(plugin as FastifyPluginAsync, pluginOptions ?? {});
		}

		await emitter.emitInit('middlewares.before', { app });
		await options.middlewares?.(app, this);
		await emitter.emitInit('middlewares.after', { app });

		await emitter.emitInit('routes.before', { app });
		await options.routes?.(app, this);
		// Phase 2 — extension endpoints.
		await this.manager.loadEndpoints(app);
		await emitter.emitInit('routes.after', { app });

		await emitter.emitInit('app.after', { app });

		await app.ready();
		this.stateValue = 'ready';
		await options.onReady?.(this);
	}

	private handleSignals(signals: NodeJS.Signals[], exitOnSignal: boolean): void {
		const onSignal = (signal: NodeJS.Signals) => {
			if (this.closePromise) {
				// Second signal while draining: stop waiting.
				this.app.log.warn({ signal }, 'Second signal during shutdown — exiting now');
				process.exit(1);
			}
			this.app.log.info({ signal }, 'Signal received, shutting down gracefully');
			this.close(signal).then(
				() => {
					if (exitOnSignal) process.exit(0);
				},
				(error: unknown) => {
					this.app.log.error({ err: error }, 'Graceful shutdown failed');
					if (exitOnSignal) process.exit(1);
				},
			);
		};

		for (const signal of signals) {
			process.on(signal, onSignal);
		}
		this.removeSignalHandlers = () => {
			for (const signal of signals) {
				process.off(signal, onSignal);
			}
			this.removeSignalHandlers = undefined;
		};
	}
}
