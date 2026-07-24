// CASE STUDY 2 — Endpoint extension.
// A single default export with manifest `type: "endpoint"` -> mounted under `/store`
// (the extension id). Shows: routes on the scoped router, the injected AppContext,
// driving the shared emitter, and CONSUMING a cross-extension service in a handler.
import { defineEndpoint } from '@codihaus/fastify-extensions/types';
import { analyticsRef } from '../../contracts.mjs';

export default defineEndpoint((router, context) => {
	router.get('/products', async () => {
		return context.db.products;
	});

	router.post('/orders', async (request, reply) => {
		try {
			// Run the payload through the filter pipeline (analytics validates + enriches).
			const order = await context.emitter.emitFilter('order.create', request.body ?? {}, {}, context);
			context.db.orders.push(order);
			// Announce it — analytics (action) and audit (wildcard action) react.
			context.emitter.emitAction('order.created', { order }, context);
			return reply.code(201).send(order);
		} catch (error) {
			return reply.code(400).send({ error: error.message });
		}
	});

	// Consume happens at REQUEST time — long after the registry is sealed, which is
	// exactly when consuming is safe.
	router.get('/analytics', async () => {
		const analytics = context.registry.tryConsume(analyticsRef);
		return analytics ? analytics.snapshot() : { unavailable: true };
	});
});
