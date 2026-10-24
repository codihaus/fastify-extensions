// Hook extension: validates orders (filter), provides AnalyticsService (init), and
// counts created orders (action).
import { defineHook } from '@codihaus/fastify-extensions/types';
import { analyticsRef, type AppContext, type Order } from '../../src/contracts.js';

export default defineHook<AppContext, AppContext>((hook, context) => {
	const stats = { orders: 0, revenue: 0 };
	let counter = 0;

	hook.filter<Partial<Order>>('order.create', (order) => {
		if (typeof order.amount !== 'number' || order.amount <= 0) {
			throw new Error('order.amount must be a positive number');
		}
		counter += 1;
		return { ...order, id: `ord_${counter}`, createdAt: context.now() };
	});

	hook.init('extensions.register', () => {
		context.registry.provide(analyticsRef, { snapshot: () => ({ ...stats }) });
	});

	hook.action('order.created', (meta) => {
		const order = meta['order'] as Order;
		stats.orders += 1;
		stats.revenue += order.amount;
	});
});
