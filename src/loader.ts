import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type {
	EndpointConfig,
	ExtensionConfig,
	ExtensionLoggerLike,
	ExtensionManifest,
	HookConfig,
	HookContext,
} from './types.js';
import type { Emitter } from './emitter.js';

/** The detected shape of a loaded extension module (see REQUIREMENTS §5.2). */
export type ExtensionShape =
	| { kind: 'bundle'; hasHooks: boolean; hasEndpoints: boolean }
	| { kind: 'hook'; fn: HookConfig<unknown, unknown> }
	| { kind: 'endpoint'; fn: EndpointConfig<unknown> }
	| { kind: 'unknown' };

/** Read and parse the package.json at an extension root. Returns null if unreadable. */
export async function readExtensionPackage(config: ExtensionConfig): Promise<Record<string, unknown> | null> {
	const packageJsonPath = join(config.resolvedPath, 'package.json');
	try {
		const content = await readFile(packageJsonPath, 'utf-8');
		return JSON.parse(content) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * Resolve the entry file for an extension, in order of precedence:
 * manifest `path` → package.json `main` → `dist/index.js`. Returns an absolute path.
 */
export function resolveEntryPoint(
	config: ExtensionConfig,
	manifest: ExtensionManifest,
	pkg: Record<string, unknown> | null,
): string {
	const entryFile =
		manifest.path ?? (typeof pkg?.['main'] === 'string' ? (pkg['main'] as string) : undefined) ?? 'dist/index.js';
	return join(config.resolvedPath, entryFile);
}

/**
 * Convert an absolute filesystem path to a `file://` URL string for dynamic import.
 * Using {@link pathToFileURL} keeps imports working on Windows, where a bare path
 * is not a valid ESM specifier.
 */
export function entryPointToUrl(absolutePath: string): string {
	return pathToFileURL(absolutePath).href;
}

/** Dynamically import an extension's entry module as a namespace record. */
export async function importExtensionModule(
	config: ExtensionConfig,
	manifest: ExtensionManifest,
	pkg: Record<string, unknown> | null,
	logger: ExtensionLoggerLike,
): Promise<Record<string, unknown>> {
	const entryPoint = resolveEntryPoint(config, manifest, pkg);
	const entryUrl = entryPointToUrl(entryPoint);
	try {
		return (await import(entryUrl)) as Record<string, unknown>;
	} catch (error) {
		logger.error({ id: config.id, entryPoint, error }, 'Failed to import extension');
		throw error;
	}
}

/**
 * Classify a loaded module (see REQUIREMENTS §5.2):
 * - a `hooks`/`endpoints` named export → bundle
 * - a function default export → endpoint when `manifest.type === 'endpoint'` and no
 *   `bundle` marker, otherwise hook
 * - anything else → unknown
 */
export function classifyModule(
	module: Record<string, unknown>,
	config: ExtensionConfig,
	manifest: ExtensionManifest,
): ExtensionShape {
	const hasHooks = typeof module['hooks'] === 'function';
	const hasEndpoints = typeof module['endpoints'] === 'function';
	if (hasHooks || hasEndpoints) {
		return { kind: 'bundle', hasHooks, hasEndpoints };
	}

	const defaultExport = module['default'];
	if (typeof defaultExport === 'function') {
		const isEndpoint = config.bundle === null && manifest.type === 'endpoint';
		if (isEndpoint) {
			return { kind: 'endpoint', fn: defaultExport as EndpointConfig<unknown> };
		}
		return { kind: 'hook', fn: defaultExport as HookConfig<unknown, unknown> };
	}

	return { kind: 'unknown' };
}

/**
 * Register a hook extension against the emitter. Builds a {@link HookContext} that
 * records an undo function for every subscription/schedule, then invokes the hook.
 * An async hook is awaited, so registrations made after an `await` still complete
 * before Phase 1 finishes.
 */
export async function registerHook<TContext>(
	hookFn: HookConfig<TContext, unknown>,
	config: ExtensionConfig,
	emitter: Emitter<unknown>,
	context: TContext,
	cleanupFns: Array<() => void | Promise<void>>,
): Promise<void> {
	const hookContext: HookContext<unknown> = {
		filter: (event, handler) => {
			emitter.onFilter(event, handler);
			cleanupFns.push(() => emitter.offFilter(event, handler));
		},
		action: (event, handler) => {
			emitter.onAction(event, handler);
			cleanupFns.push(() => emitter.offAction(event, handler));
		},
		init: (event, handler) => {
			emitter.onInit(event, handler);
			cleanupFns.push(() => emitter.offInit(event, handler));
		},
		schedule: (cron, handler) => {
			const name = `ext:${config.id}:${cron}`;
			const unregister = emitter.addSchedule(name, cron, handler);
			cleanupFns.push(unregister);
		},
	};

	await hookFn(hookContext, context);
}

/**
 * Mount an endpoint extension on a scoped Fastify register under `prefix`
 * (default `/<extension-id>`). Fastify routes cannot be unregistered, so this
 * returns no cleanup functions.
 *
 * A setup error is captured INSIDE the scoped plugin and rethrown here after the
 * register call resolves. Letting the error reject `app.register` itself would put
 * the Fastify instance (avvio) into a terminal boot-error state and poison every
 * later extension's registration — capturing keeps error isolation per extension.
 * Routes the setup function added before throwing stay mounted (partial mount);
 * the caller decides how to report that.
 */
export async function registerEndpoint<TContext>(
	endpointFn: EndpointConfig<TContext>,
	config: ExtensionConfig,
	app: FastifyInstance,
	context: TContext,
	prefix?: string,
): Promise<void> {
	const routePrefix = prefix ?? `/${config.id}`;
	let setupError: unknown;
	await app.register(
		async (scopedApp) => {
			try {
				await endpointFn(scopedApp, context);
			} catch (error) {
				setupError = error;
			}
		},
		{ prefix: routePrefix },
	);
	if (setupError !== undefined) {
		throw setupError;
	}
}

/**
 * Phase 1: register the hook side of a module. Endpoint registration is deferred to
 * {@link registerModuleEndpoints}. On a registration error the partial cleanups are
 * run before rethrowing, so no half-registered hooks are left behind.
 *
 * Returns `null` for an unrecognized module shape — the caller must treat the
 * extension as skipped, never as loaded.
 */
export async function registerModuleHooks<TContext>(
	module: Record<string, unknown>,
	config: ExtensionConfig,
	manifest: ExtensionManifest,
	emitter: Emitter<unknown>,
	context: TContext,
	logger: ExtensionLoggerLike,
): Promise<Array<() => void | Promise<void>> | null> {
	const shape = classifyModule(module, config, manifest);

	if (shape.kind === 'unknown') {
		logger.warn({ id: config.id }, 'Unrecognized extension shape, skipping');
		return null;
	}

	const cleanupFns: Array<() => void | Promise<void>> = [];

	try {
		if (shape.kind === 'bundle') {
			if (shape.hasHooks) {
				await registerHook(module['hooks'] as HookConfig<TContext, unknown>, config, emitter, context, cleanupFns);
			}
		} else if (shape.kind === 'hook') {
			await registerHook(shape.fn as HookConfig<TContext, unknown>, config, emitter, context, cleanupFns);
		}
		// endpoint-only extensions register nothing in Phase 1
	} catch (error) {
		for (const cleanup of cleanupFns) {
			try {
				await cleanup();
			} catch {
				// Ignore cleanup errors while unwinding a failed registration.
			}
		}
		throw error;
	}

	return cleanupFns;
}

/**
 * Phase 2: mount the endpoint side of a module.
 * - bundle: `endpoints` mounts under `/<first endpoint entry name, else id>`; each
 *   manifest endpoint entry `X` with an `endpoint_X` export mounts under `/X`.
 * - endpoint default export: mounts under `/<id>`.
 */
export async function registerModuleEndpoints<TContext>(
	module: Record<string, unknown>,
	config: ExtensionConfig,
	manifest: ExtensionManifest,
	app: FastifyInstance,
	context: TContext,
): Promise<void> {
	const shape = classifyModule(module, config, manifest);

	if (shape.kind === 'bundle') {
		if (shape.hasEndpoints) {
			const firstEndpointEntry = config.entries.find((entry) => entry.type === 'endpoint');
			const prefix = `/${firstEndpointEntry?.name ?? config.id}`;
			await registerEndpoint(module['endpoints'] as EndpointConfig<TContext>, config, app, context, prefix);
		}

		const endpointEntries = config.entries.filter((entry) => entry.type === 'endpoint');
		for (const entry of endpointEntries) {
			const exportKey = `endpoint_${entry.name}`;
			if (typeof module[exportKey] === 'function') {
				await registerEndpoint(module[exportKey] as EndpointConfig<TContext>, config, app, context, `/${entry.name}`);
			}
		}
	} else if (shape.kind === 'endpoint') {
		await registerEndpoint(shape.fn as EndpointConfig<TContext>, config, app, context, `/${config.id}`);
	}
}
