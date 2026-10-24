import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { ServerExtension } from '@codihaus/fastify-extensions';
import { appOptions } from './app.js';

const kit = await ServerExtension.create({ ...appOptions(), fastify: { logger: false } });

try {
	const overview = await kit.app.inject({ method: 'GET', url: '/' });
	assert.deepEqual(overview.json(), { app: 'kit-app', loaded: ['analytics', 'store'] });

	const catalog = await kit.app.inject({ method: 'GET', url: '/catalog' });
	assert.match(catalog.body, /<li>Widget — 9.99<\/li>/);

	const ready = await kit.app.inject({ method: 'GET', url: '/health/ready' });
	assert.equal(ready.statusCode, 200);

	const rejected = await kit.app.inject({ method: 'POST', url: '/store/orders', payload: { productId: 'p1', amount: -1 } });
	assert.equal(rejected.statusCode, 400);

	const order = await kit.app.inject({ method: 'POST', url: '/store/orders', payload: { productId: 'p1', amount: 9.99 } });
	assert.equal(order.statusCode, 201);
	assert.equal(order.json().id, 'ord_1');

	// Actions are fire-and-forget: let the analytics handler run.
	await setImmediate();
	const analytics = await kit.app.inject({ method: 'GET', url: '/store/analytics' });
	assert.deepEqual(analytics.json(), { orders: 1, revenue: 9.99 });

	console.log('kit-app smoke test passed');
} finally {
	await kit.close();
}
