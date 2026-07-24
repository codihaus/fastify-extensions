import type { FastifyInstance } from 'fastify';
import { ExtensionManager, type ExtensionManagerOptions } from './manager.js';

declare module 'fastify' {
	interface FastifyInstance {
		/**
		 * The {@link ExtensionManager} instance registered by {@link fastifyExtensions}.
		 *
		 * Scope caveat: this decorator exists on the Fastify instance the plugin ran on.
		 * With `app.register(fastifyExtensions, …)` that is the ENCAPSULATED child scope —
		 * routes inside the scope can read it, but the OUTER `app.extensions` stays
		 * undefined. Use the `onManager` option (or direct invocation) to get the manager
		 * on the outside.
		 */
		extensions: ExtensionManager<unknown>;
	}
}

/** Options for {@link fastifyExtensions}: manager options plus plugin-specific hooks. */
export interface FastifyExtensionsOptions<TContext> extends ExtensionManagerOptions<TContext> {
	/**
	 * Called with the manager instance once loading completes. This is the supported
	 * way to obtain the manager when registering via `app.register()`, because the
	 * `extensions` decorator stays inside the encapsulated registration scope.
	 */
	onManager?: (manager: ExtensionManager<TContext>) => void;
}

/**
 * Single-phase Fastify plugin convenience wrapper for hosts that do not need
 * pre-server hooks: creates an {@link ExtensionManager}, runs Phase 1
 * (`scanAndLoadHooks`) then Phase 2 (`loadEndpoints`) against the instance it runs
 * on, decorates that instance with `extensions`, and resets the manager on `onClose`.
 *
 * Two supported usage forms:
 *
 * 1. **Scoped routes** — `await app.register(fastifyExtensions, options)`.
 *    The plugin is deliberately NOT wrapped with `fastify-plugin`, so Fastify runs it
 *    in an encapsulated child scope: extension routes are confined to that scope and
 *    the `extensions` decorator is visible only inside it. To hold the manager on the
 *    outside, pass `onManager`:
 *
 *    ```ts
 *    let manager;
 *    await app.register(fastifyExtensions, {
 *      manifestKey: 'myapp-extension',
 *      extensionsPath: './extensions',
 *      createContext: (config) => ({ ... }),
 *      onManager: (created) => { manager = created; },
 *    });
 *    ```
 *
 * 2. **Direct invocation** — `await fastifyExtensions(app, options)`.
 *    Runs against `app` itself: routes mount at the root and `app.extensions` is set
 *    on the exact instance you hold.
 */
export async function fastifyExtensions<TContext>(
	app: FastifyInstance,
	options: FastifyExtensionsOptions<TContext>,
): Promise<void> {
	const { onManager, ...managerOptions } = options;
	const manager = new ExtensionManager<TContext>(managerOptions);

	await manager.scanAndLoadHooks();
	await manager.loadEndpoints(app);

	app.decorate('extensions', manager as ExtensionManager<unknown>);
	app.addHook('onClose', async () => {
		await manager.reset();
	});

	if (onManager) {
		onManager(manager);
	}
}
