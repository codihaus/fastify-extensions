import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from '../routes.js';

export function homeController({ services }: AppDeps) {
	return {
		async index(_request: FastifyRequest, reply: FastifyReply) {
			return reply.view('home/index', { title: 'Home', products: services.products.list().slice(0, 3) });
		},
	};
}
