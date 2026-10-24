import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppKitOptions } from '@codihaus/fastify-extensions';
import type { AppContext, Db } from './contracts.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Fresh in-memory database per app instance. */
export function createDb(): Db {
	return {
		products: [
			{ id: 'p1', name: 'Widget', price: 9.99 },
			{ id: 'p2', name: 'Gadget', price: 19.99 },
		],
		orders: [],
	};
}

/**
 * Kit options shared by server.ts (ServerExtension.start) and test.ts
 * (ServerExtension.create). This file is the whole bootstrap.
 */
export function appOptions(db: Db = createDb()): AppKitOptions<AppContext> {
	return {
		name: 'kit-app',
		extensions: {
			manifestKey: 'kit-app-extension',
			extensionsPath: join(root, 'extensions'),
			moduleRoot: false,
			mustLoad: ['analytics', 'store'],
		},
		context: (base) => ({ ...base, db, now: () => new Date().toISOString() }),
		routes: (app, kit) => {
			app.get('/', async () => ({ app: kit.name, loaded: kit.extensions.map((config) => config.id) }));
			// Liquid is the kit default view engine; templates live in ./views.
			app.get('/catalog', async (_request, reply) => reply.view('catalog', { products: db.products }));
		},
		view: { root: join(root, 'views'), defaultContext: { appName: 'kit-app' } },
		health: { checks: { db: () => (db.products.length > 0 ? true : Promise.reject(new Error('empty catalog'))) } },
	};
}
