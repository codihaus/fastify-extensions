import type { FastifyInstance } from 'fastify';
import type { AppConfig } from './config.js';
import { homeController } from './controllers/home.controller.js';
import { productController } from './controllers/product.controller.js';
import type { AppServices } from './services/index.js';

/** What controllers receive. */
export interface AppDeps {
	config: AppConfig;
	services: AppServices;
}

/** URL -> controller map. Extension endpoints mount after these, under their own prefix. */
export function registerRoutes(app: FastifyInstance, deps: AppDeps): void {
	const home = homeController(deps);
	const products = productController(deps);

	app.get('/', home.index);
	app.get('/products', products.index);

	app.get('/api/products', products.list);
	app.get('/api/products/:id', products.show);
	app.post(
		'/api/products',
		{
			schema: {
				body: {
					type: 'object',
					required: ['name', 'price'],
					properties: { name: { type: 'string', maxLength: 200 }, price: { type: 'number' } },
				},
			},
		},
		products.create,
	);
}
