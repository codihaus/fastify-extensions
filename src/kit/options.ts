import type {
	FastifyError,
	FastifyInstance,
	FastifyListenOptions,
	FastifyPluginAsync,
	FastifyPluginCallback,
	FastifyReply,
	FastifyRequest,
	FastifyServerOptions,
} from 'fastify';
import type { ExtensionManagerOptions } from '../kernel/manager.js';
import type { Emitter } from '../runtime/emitter.js';
import type { ExtensionConfig, ExtensionLoggerLike, ServiceRegistry } from '../types.js';
import type { AppKitHealthOptions } from './health.js';
import type { ServerExtension } from './server-extension.js';
import type { ShutdownPhase } from './shutdown.js';
import type { AppKitViewOptions } from './view.js';

/** Lifecycle state of a {@link ServerExtension}. */
export type AppKitState = 'building' | 'ready' | 'listening' | 'closing' | 'closed';

/**
 * Init events the kit emits on the shared emitter, in this order, each with meta
 * `{ app }`. Extensions subscribe with `hook.init('<event>', ...)`; the registry is
 * already sealed, so `consume()` works inside every one of them.
 */
export const APP_KIT_INIT_EVENTS = [
	'app.before',
	'middlewares.before',
	'middlewares.after',
	'routes.before',
	'routes.after',
	'app.after',
] as const;

/** The context every extension receives when the host does not supply `context`. */
export interface AppKitBaseContext {
	/** Loaded extension id. */
	extensionId: string;
	/** The app `name` option. */
	appName: string;
	/** Resolved discovery config of the extension. */
	config: ExtensionConfig;
	/** Logger bound to `{ extension: <id> }`. */
	logger: ExtensionLoggerLike;
	/** Shared emitter — emit host-style events from request handlers. */
	emitter: Emitter<unknown>;
	/** Cross-extension service registry. */
	registry: ServiceRegistry;
	/** Register a resource to release on shutdown. Returns an unregister function. */
	onShutdown(phase: ShutdownPhase, name: string, run: () => void | Promise<void>): () => void;
}

/** Extension discovery options. Same meaning as on {@link ExtensionManagerOptions}. */
export type AppKitExtensionsOptions = Pick<
	ExtensionManagerOptions<unknown>,
	'manifestKey' | 'extensionsPath' | 'moduleRoot' | 'mustLoad' | 'isEnabled' | 'onManifest' | 'scheduleLock'
>;

type AppKitPluginFn =
	| FastifyPluginCallback<any>
	| FastifyPluginAsync<any>
	| Promise<{ default: FastifyPluginCallback<any> | FastifyPluginAsync<any> }>;

/** A Fastify plugin, an `import('…')` promise of one, or a `[plugin, options]` pair. */
export type AppKitPlugin = AppKitPluginFn | [AppKitPluginFn, Record<string, unknown>];

/** A host callback that receives the Fastify app and the kit. */
export type AppKitStep<TContext> = (app: FastifyInstance, kit: ServerExtension<TContext>) => void | Promise<void>;

/** Options for {@link ServerExtension.create} / {@link ServerExtension.start}. */
export interface AppKitOptions<TContext = AppKitBaseContext> {
	/** App name, used in logs and in the default context. Default `"app"`. */
	name?: string;

	/** Options passed to `Fastify()`. They override the kit defaults (logger, request id). */
	fastify?: FastifyServerOptions;

	/** Extension discovery. Omit or `false` to run the kit without extensions. */
	extensions?: AppKitExtensionsOptions | false;

	/**
	 * Build the context for each extension from the kit base context. Called once per
	 * loaded extension id. Default: the base context itself.
	 */
	context?: (base: AppKitBaseContext) => TContext;

	/** Provide host services. Runs after extension hooks load, before `extensions.register`. */
	services?: (registry: ServiceRegistry, kit: ServerExtension<TContext>) => void | Promise<void>;

	/** Fastify plugins registered after `app.before` (cors, helmet, cookie, ...). */
	plugins?: AppKitPlugin[];

	/** Global hooks (auth, rate limit, ...). Runs between `middlewares.before` and `middlewares.after`. */
	middlewares?: AppKitStep<TContext>;

	/** Host routes. Runs after `routes.before`, before extension endpoints mount. */
	routes?: AppKitStep<TContext>;

	/** Called after `app.ready()`, before `listen()`. */
	onReady?: (kit: ServerExtension<TContext>) => void | Promise<void>;

	/** Called on shutdown in the `connections` phase (close DB pools here). */
	onClose?: (kit: ServerExtension<TContext>) => void | Promise<void>;

	/** Health probes. Default enabled at `/health`. `false` disables. */
	health?: AppKitHealthOptions | boolean;

	/**
	 * Template rendering via `@fastify/view`. Default enabled: Liquid, templates in
	 * `<cwd>/views`. Pick `pug` or `twig` with `{ engine }`. `false` disables.
	 */
	view?: AppKitViewOptions | false;

	/**
	 * Use `x-request-id` (when it is a safe token) as the request id, else a UUID, and
	 * echo the request id on every reply. Default `true`. A `fastify.genReqId` replaces
	 * the id source; the echo stays.
	 */
	requestId?: boolean;

	/** Accept an empty body with `content-type: application/json`. Default `true`. */
	acceptEmptyJson?: boolean;

	/** Error handler. Default: Fastify-shaped body, 5xx messages hidden. `false` keeps Fastify's. */
	errorHandler?: ((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => unknown) | false;

	/** 404 handler. Default: `ROUTE_NOT_FOUND` without the query string. `false` keeps Fastify's. */
	notFoundHandler?: ((request: FastifyRequest, reply: FastifyReply) => unknown) | false;

	/** Max time one shutdown hook may take before shutdown moves on. Default 10000 ms. */
	shutdownTimeoutMs?: number;

	/** `start()` only: listen port. Default 3000. */
	port?: number;

	/** `start()` only: listen host. Default `127.0.0.1`; use `0.0.0.0` in containers. */
	host?: string;

	/** `start()` only: extra listen options. */
	listen?: FastifyListenOptions;

	/** `start()` only: signals that trigger graceful shutdown. Default SIGINT + SIGTERM. `false` disables. */
	signals?: NodeJS.Signals[] | false;

	/** `start()` only: exit the process after a signal-triggered shutdown. Default `true`. */
	exitOnSignal?: boolean;
}
