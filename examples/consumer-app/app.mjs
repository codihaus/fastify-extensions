import Fastify from 'fastify';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExtensionManager, createConsoleLogger } from '@codihaus/fastify-extensions';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Build the host without opening a TCP port. Keeping boot separate from listen()
 * lets the same real application power both the example server and its smoke test.
 *
 * @param {{ logger?: import('@codihaus/fastify-extensions').ExtensionLoggerLike }} [options]
 */
export async function buildApp(options = {}) {
	const logger = options.logger ?? createConsoleLogger({ app: 'consumer-app' });
	const contextCreationCounts = new Map();

	// A stand-in database shared across extensions through the host-owned context.
	const db = {
		orders: [],
		audit: [],
		products: [
			{ id: 'p1', name: 'Widget', price: 9.99 },
			{ id: 'p2', name: 'Gadget', price: 19.99 },
		],
	};

	let manager;
	manager = new ExtensionManager({
		manifestKey: 'consumer-extension',
		extensionsPath: join(here, 'extensions'),
		moduleRoot: false,
		logger,
		mustLoad: ['analytics', 'audit', 'store'],
		// This extension remains discoverable, but host policy prevents it from loading.
		isEnabled: (id) => id !== 'disabled-feature',
		createContext: (config) => {
			contextCreationCounts.set(config.id, (contextCreationCounts.get(config.id) ?? 0) + 1);

			return {
				extensionId: config.id,
				appName: 'consumer-app',
				logger: logger.child({ extension: config.id }),
				db,
				emitter: manager.emitter,
				registry: manager.registry,
				now: () => new Date().toISOString(),
			};
		},
		onManifest: (pkg, config) => {
			logger.info({ id: config.id, version: pkg.version, source: config.source }, 'manifest seen');
		},
	});

	// Discovery is intentionally separate so the example can show that discovered
	// extensions and enabled/loaded extensions are different sets.
	const discoveredExtensions = await manager.scanExtensions();

	// Phase 1: hooks, actions, init handlers, and schedules exist before Fastify.
	await manager.scanAndLoadHooks();

	const app = Fastify({ logger: false });

	app.get('/', async () => ({
		app: 'consumer-app',
		discovered: discoveredExtensions.map((config) => config.id),
		loaded: manager.getExtensions().map((config) => config.id),
		contextCreations: Object.fromEntries(contextCreationCounts),
	}));

	// Phase 2: routes mount, extensions.register fires, and the registry seals.
	await manager.loadEndpoints(app);

	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		await app.close();
		await manager.reset();
	};

	return {
		app,
		manager,
		close,
		discoveredExtensions,
		contextCreationCounts,
	};
}
