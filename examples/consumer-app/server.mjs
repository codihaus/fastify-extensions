import Fastify from 'fastify';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExtensionManager, createConsoleLogger } from '@codihaus/fastify-extensions';

const here = dirname(fileURLToPath(import.meta.url));
const logger = createConsoleLogger({ app: 'consumer-app' });

/**
 * The host defines its OWN context shape. The package is generic over it and never
 * assumes what is inside. A real app would publish this type from its own package so
 * extension authors get `defineHook<AppContext>` / `defineEndpoint<AppContext>`.
 *
 * @typedef {Object} AppContext
 * @property {string} extensionId
 * @property {string} appName
 * @property {import('@codihaus/fastify-extensions').ExtensionLoggerLike} logger
 * @property {{ orders: any[], audit: any[], products: any[] }} db
 * @property {import('@codihaus/fastify-extensions').Emitter} emitter
 * @property {import('@codihaus/fastify-extensions').ServiceRegistry} registry
 * @property {() => string} now
 */

// A stand-in "database" shared across every extension via the injected context.
const db = {
	orders: [],
	audit: [],
	products: [
		{ id: 'p1', name: 'Widget', price: 9.99 },
		{ id: 'p2', name: 'Gadget', price: 19.99 },
	],
};

const manager = new ExtensionManager({
	manifestKey: 'consumer-extension',
	extensionsPath: join(here, 'extensions'),
	moduleRoot: false,
	logger,
	// Called once per extension. The closure captures `manager`, which is safe because
	// createContext only runs later (during scanAndLoadHooks), after `manager` is assigned.
	createContext: (config) => ({
		extensionId: config.id,
		appName: 'consumer-app',
		logger: logger.child({ extension: config.id }),
		db,
		emitter: manager.emitter,
		registry: manager.registry,
		now: () => new Date().toISOString(),
	}),
	onManifest: (pkg, config) => {
		logger.info({ id: config.id, version: pkg.version, source: config.source }, 'manifest seen');
	},
});

// ── Phase 1: register hooks + schedules + service providers (no server yet) ──────
await manager.scanAndLoadHooks();

const app = Fastify({ logger: false });

// A base host route (not from any extension) that reports what got loaded.
app.get('/', async () => ({
	app: 'consumer-app',
	extensions: manager.getExtensions().map((config) => ({
		id: config.id,
		source: config.source,
		entries: config.entries,
	})),
}));

// ── Phase 2: mount endpoints, emit 'extensions.register', seal the registry ──────
await manager.loadEndpoints(app);

const port = Number(process.env.PORT ?? 3100);
await app.listen({ port, host: '127.0.0.1' });
logger.info({ port }, 'consumer-app listening');

// Graceful shutdown runs every extension's cleanup functions.
for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, async () => {
		await app.close();
		await manager.reset();
		process.exit(0);
	});
}
