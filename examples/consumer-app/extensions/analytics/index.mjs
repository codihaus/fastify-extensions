// CASE STUDY 1 — Hook extension.
// Demonstrates all four hook capabilities against the injected AppContext:
//   filter  — validate + enrich the order payload before it is stored
//   init    — provide a cross-extension service during the 'extensions.register' window
//   action  — fire-and-forget analytics on every created order
//   schedule— a cron heartbeat coordinated by the manager's ScheduleLock
import { defineHook } from '@codihaus/fastify-extensions/types';
import { analyticsRef } from '../../contracts.mjs';

let orderCounter = 0;

export default defineHook((hook, context) => {
	// Provider-owned state; the snapshot() service and the action both close over it.
	const stats = { orders: 0, revenue: 0 };

	// FILTER: runs in the pipeline when the store endpoint emits 'order.create'.
	// Throwing here rejects emitFilter, so the endpoint returns 400 for bad input.
	hook.filter('order.create', (order) => {
		if (typeof order.amount !== 'number' || order.amount <= 0) {
			throw new Error('order.amount must be a positive number');
		}
		orderCounter += 1;
		return { ...order, id: `ord_${orderCounter}`, createdAt: context.now() };
	});

	// INIT: the register window is the only place a provider should call provide().
	hook.init('extensions.register', () => {
		context.registry.provide(analyticsRef, {
			snapshot: () => ({ ...stats }),
		});
		context.logger.info('AnalyticsService provided');
	});

	// ACTION: fire-and-forget; errors here are logged by the emitter, never thrown.
	hook.action('order.created', (meta) => {
		stats.orders += 1;
		stats.revenue += meta.order.amount;
		context.logger.info({ orderId: meta.order.id, revenue: stats.revenue }, 'analytics recorded order');
	});

	// SCHEDULE: fires every minute. With the default MemoryScheduleLock this runs on
	// the single instance; back the lock with Redis/DB to run once per cluster tick.
	hook.schedule('*/1 * * * *', async () => {
		context.logger.info({ snapshot: { ...stats } }, 'analytics heartbeat');
	});
});
