import type { FastifyReply, FastifyRequest } from 'fastify';
import type { NewProduct } from '../models/product.model.js';
import type { AppDeps } from '../routes.js';

export function productController({ services }: AppDeps) {
	return {
		/** HTML page. */
		async index(_request: FastifyRequest, reply: FastifyReply) {
			return reply.view('products/index', { title: 'Products', products: services.products.list() });
		},

		/** JSON API. */
		async list() {
			return services.products.list();
		},

		async show(request: FastifyRequest<{ Params: { id: string } }>) {
			return services.products.get(request.params.id);
		},

		async create(request: FastifyRequest<{ Body: NewProduct }>, reply: FastifyReply) {
			const product = await services.products.create(request.body);
			return reply.code(201).send(product);
		},
	};
}
