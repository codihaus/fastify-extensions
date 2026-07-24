/**
 * Public type surface for `@codihaus/fastify-extensions`.
 *
 * This module is exposed under the `./types` subpath so that extension AUTHORS can
 * depend on a tiny, loader-free surface (types + `define*` helpers + `createServiceRef`)
 * without pulling in the manager, emitter, or any Node runtime code.
 *
 * A host application typically re-publishes these symbols from its own types package,
 * pre-bound to the host's concrete context type — mirroring how ODP extensions import
 * only `@odp/api/types`.
 *
 * The only external reference here is a TYPE-ONLY import of Fastify, so this module
 * stays runtime-free even when `fastify` is not installed.
 */

import type { FastifyInstance } from 'fastify';

// ════════════════════════════════════════════════════════════════════════════
// Event handler types
// ════════════════════════════════════════════════════════════════════════════

/**
 * A filter handler transforms a payload and returns the (possibly changed) value.
 * Filters run sequentially; each receives the previous handler's output. A thrown
 * error propagates out of `emitFilter`.
 *
 * @typeParam TPayload - shape of the value flowing through the filter pipeline.
 * @typeParam TEventContext - host-defined event context passed as the third argument.
 */
export type FilterHandler<TPayload = unknown, TEventContext = unknown> = (
	payload: TPayload,
	meta: Record<string, unknown>,
	context: TEventContext,
) => TPayload | Promise<TPayload>;

/**
 * An action handler performs side effects. Actions are fire-and-forget: they run in
 * parallel and their errors are logged, never thrown back to the emitter caller.
 *
 * @typeParam TEventContext - host-defined event context passed as the second argument.
 */
export type ActionHandler<TEventContext = unknown> = (
	meta: Record<string, unknown>,
	context: TEventContext,
) => void | Promise<void>;

/**
 * An init handler performs initialization work. Init handlers run sequentially and
 * are awaited; a thrown error propagates out of `emitInit`.
 */
export type InitHandler = (meta: Record<string, unknown>) => void | Promise<void>;

// ════════════════════════════════════════════════════════════════════════════
// Hook extension API
// ════════════════════════════════════════════════════════════════════════════

/**
 * The registration surface handed to a hook extension as its first argument.
 * Every call records an internal cleanup function so the extension can be fully
 * unloaded later.
 *
 * @typeParam TEventContext - host-defined event context threaded to filter/action handlers.
 */
export interface HookContext<TEventContext = unknown> {
	/** Subscribe to a filter event (sequential, transforming). */
	filter<TPayload = unknown>(
		event: string,
		handler: FilterHandler<TPayload, TEventContext>,
	): void;
	/** Subscribe to an action event (parallel, fire-and-forget). */
	action(event: string, handler: ActionHandler<TEventContext>): void;
	/** Subscribe to an init event (sequential, awaited). */
	init(event: string, handler: InitHandler): void;
	/** Register a cron schedule. The job name is namespaced as `ext:<extension-id>:<cron>`. */
	schedule(cron: string, handler: () => Promise<void>): void;
}

/**
 * A hook extension: subscribes to events and/or registers schedules.
 * May be async — the loader awaits it, so registrations made after an `await`
 * still complete before Phase 1 finishes.
 *
 * @typeParam TContext - the host-defined context injected as the second argument.
 * @typeParam TEventContext - host-defined event context threaded to filter/action handlers.
 */
export type HookConfig<TContext = unknown, TEventContext = unknown> = (
	hook: HookContext<TEventContext>,
	context: TContext,
) => void | Promise<void>;

/**
 * An endpoint extension: registers Fastify routes on the scoped router.
 * May be async — the loader awaits it before considering the extension mounted.
 *
 * @typeParam TContext - the host-defined context injected as the second argument.
 */
export type EndpointConfig<TContext = unknown> = (
	router: FastifyInstance,
	context: TContext,
) => void | Promise<void>;

/**
 * Identity helper that gives an inline hook extension its type parameters without a cast.
 *
 * @example
 * export default defineHook<MyContext, MyEventContext>((hook, context) => {
 *   hook.action('user.created', async (meta) => { ... });
 * });
 */
export function defineHook<TContext = unknown, TEventContext = unknown>(
	fn: HookConfig<TContext, TEventContext>,
): HookConfig<TContext, TEventContext> {
	return fn;
}

/**
 * Identity helper that gives an inline endpoint extension its type parameter without a cast.
 *
 * @example
 * export default defineEndpoint<MyContext>((router, context) => {
 *   router.get('/ping', async () => ({ ok: true }));
 * });
 */
export function defineEndpoint<TContext = unknown>(
	fn: EndpointConfig<TContext>,
): EndpointConfig<TContext> {
	return fn;
}

// ════════════════════════════════════════════════════════════════════════════
// Manifest + discovery config
// ════════════════════════════════════════════════════════════════════════════

/** A declared bundle entry under the manifest's `entries` array. */
export interface ExtensionEntry {
	type: 'hook' | 'endpoint';
	name: string;
}

/**
 * The parsed contents of `pkg[manifestKey]`. Unknown extra fields are preserved via
 * the index signature and forwarded untouched to the `onManifest` callback.
 */
export interface ExtensionManifest {
	/** Optional id override. Defaults to the folder name (local) or package name (module). */
	id?: string;
	/** Only meaningful for single-default-export extensions. */
	type?: 'hook' | 'endpoint';
	/** Entry file override, relative to the extension root. */
	path?: string;
	/** Non-null marks a bundle-ish default export as a hook (kept for ODP parity). */
	bundle?: string | null;
	/** Bundle entries, each mounted under its own prefix. */
	entries?: ExtensionEntry[];
	/** Host-specific fields flow through untouched. */
	[extraField: string]: unknown;
}

/** A discovered extension, resolved but not necessarily loaded. */
export interface ExtensionConfig {
	/** Stable identifier (manifest `id`, else folder/package name). */
	id: string;
	/** Folder name (local) or package name (module) the extension was discovered under. */
	folder: string;
	/** Where the extension came from. */
	source: 'local' | 'module';
	/** Manifest `bundle` value, or `null`. */
	bundle: string | null;
	/** Manifest `path` entry override, or `null`. */
	path: string | null;
	/** Declared bundle entries (empty when none). */
	entries: ExtensionEntry[];
	/** Absolute path to the extension root directory. */
	resolvedPath: string;
}

/** A fully loaded extension together with its undo functions. */
export interface LoadedExtension {
	config: ExtensionConfig;
	/**
	 * Undo functions for every hook/schedule registered by this extension. A cleanup
	 * may be async (e.g. releasing a distributed ScheduleLock); `unloadExtension` and
	 * `reset` await them in reverse registration order.
	 */
	cleanupFns: Array<() => void | Promise<void>>;
}

// ════════════════════════════════════════════════════════════════════════════
// Cross-extension service registry
// ════════════════════════════════════════════════════════════════════════════

/**
 * A typed handle to a shared service. The phantom `__type` carries `T` through the
 * generic so consumers get the impl type back from `consume`/`tryConsume` without
 * casting. The runtime key is `id` only.
 */
export interface ServiceRef<T> {
	id: string;
	readonly __type?: T;
}

/**
 * Create a typed service ref. Both provider and consumer import the same ref from a
 * shared contract module.
 */
export function createServiceRef<T>(id: string): ServiceRef<T> {
	return { id };
}

/**
 * Share services across extensions. Providers register during the `extensions.register`
 * init event; the registry is then sealed before any consumer runs.
 */
export interface ServiceRegistry {
	/** Register an implementation under a typed ref. */
	provide<T>(ref: ServiceRef<T>, impl: T): void;
	/** Hard dependency — returns the impl, throws if absent. */
	consume<T>(ref: ServiceRef<T>): T;
	/** Soft dependency — returns the impl or `undefined`. Accepts a typed ref or a plain string id. */
	tryConsume<T>(ref: ServiceRef<T> | string): T | undefined;
	/** True if a provider is registered for that id. */
	has(id: string): boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// Logger
// ════════════════════════════════════════════════════════════════════════════

/**
 * Minimal structured logger interface. Structurally compatible with pino, so a host
 * can pass `app.log` or a pino instance directly with zero glue.
 */
export interface ExtensionLoggerLike {
	debug(obj: unknown, msg?: string): void;
	info(obj: unknown, msg?: string): void;
	warn(obj: unknown, msg?: string): void;
	error(obj: unknown, msg?: string): void;
	child(bindings: Record<string, unknown>): ExtensionLoggerLike;
}

// ════════════════════════════════════════════════════════════════════════════
// Schedule lock (multi-instance coordination)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Coordinates cron ticks across multiple host instances. The default in-memory lock
 * always claims (correct for a single instance); hosts back it with Redis/DB for a
 * cluster so only one instance runs a given tick.
 */
export interface ScheduleLock {
	/** Claim the tick identified by `(name, timestamp)`. `true` means this instance runs it. */
	claim(name: string, timestamp: number): Promise<boolean>;
	/** Release state for a job (called when the schedule stops). */
	release(name: string): Promise<void>;
}
