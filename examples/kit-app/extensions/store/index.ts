// Endpoint extension, mounted under /store. Runs orders through the filter pipeline,
// announces them, and consumes AnalyticsService at request time.
import { defineEndpoint } from '@codihaus/fastify-extensions/types';
import { analyticsRef, type AppContext, type Order } from '../../src/contracts.js';

export default defineEndpoint<AppContext>((router, context) => {
	router.get('/products', async () => context.db.products);

	router.post<{ Body: Partial<Order> }>('/orders', async (request, reply) => {
		try {
			const order = (await context.emitter.emitFilter('order.create', request.body ?? {}, {}, context)) as Order;
			context.db.orders.push(order);
			context.emitter.emitAction('order.created', { order }, context);
			return reply.code(201).send(order);
		} catch (error) {
			return reply.code(400).send({ error: (error as Error).message });
		}
	});

	router.get('/analytics', async () => context.registry.tryConsume(analyticsRef)?.snapshot() ?? { unavailable: true });
});
