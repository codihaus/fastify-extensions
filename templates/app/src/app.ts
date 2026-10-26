import { join } from 'node:path';
import type { AppKitOptions } from '@codihaus/fastify-extensions';
import { loadConfig, type AppConfig } from './config.js';
import type { AppContext } from './contracts.js';
import { registerMiddlewares } from './middlewares/index.js';
import { createModels } from './models/index.js';
import { registerRoutes } from './routes.js';
import { createServices, type AppServices, type EventBus } from './services/index.js';

/**
 * The whole bootstrap. server.ts starts it; tests create it without listening.
 * Boot order (kit): extension hooks -> services sealed -> plugins -> middlewares ->
 * routes -> extension endpoints -> ready.
 */
export function appOptions(config: AppConfig = loadConfig()): AppKitOptions<AppContext> {
	const models = createModels();
	// Services emit events on the kit emitter, which exists once the kit starts building.
	let services: AppServices | undefined;
	const servicesFor = (events: EventBus) => (services ??= createServices(models, events));

	return {
		name: config.name,
		fastify: { logger: { level: config.logLevel } },
		extensions: {
			manifestKey: '__MANIFEST_KEY__',
			extensionsPath: join(config.root, 'extensions'),
			// Boot fails when one of these does not load.
			mustLoad: ['audit', 'reports'],
		},
		context: (base) => ({ ...base, appConfig: config, services: servicesFor(base.emitter) }),
		plugins: [[import('@fastify/static'), { root: join(config.root, 'public'), prefix: '/public/' }]],
		middlewares: (app) => registerMiddlewares(app),
		routes: (app, kit) => registerRoutes(app, { config, services: servicesFor(kit.emitter) }),
		view: {
			engine: '__VIEW_ENGINE__',
			root: join(config.root, 'views'),
			defaultContext: { appName: config.name },
		},
		health: {
			// One check per dependency. A check that throws or times out makes /health/ready return 503.
			// Example: checks: { database: () => db.raw('select 1') },
			checks: {},
		},
	};
}
