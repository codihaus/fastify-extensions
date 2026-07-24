import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { buildApp } from './app.mjs';

const silentLogger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
	child() {
		return this;
	},
};

const runtime = await buildApp({ logger: silentLogger });

try {
	const overview = await runtime.app.inject({ method: 'GET', url: '/' });
	assert.equal(overview.statusCode, 200);
	assert.deepEqual(overview.json(), {
		app: 'consumer-app',
		discovered: ['analytics', 'audit', 'disabled-feature', 'store'],
		loaded: ['analytics', 'audit', 'store'],
		contextCreations: {
			analytics: 1,
			audit: 1,
			store: 1,
		},
	});

	const products = await runtime.app.inject({ method: 'GET', url: '/store/products' });
	assert.equal(products.statusCode, 200);
	assert.equal(products.json().length, 2);

	const invalidOrder = await runtime.app.inject({
		method: 'POST',
		url: '/store/orders',
		payload: { product: 'p1', amount: -5 },
	});
	assert.equal(invalidOrder.statusCode, 400);
	assert.match(invalidOrder.json().error, /positive number/);

	const validOrder = await runtime.app.inject({
		method: 'POST',
		url: '/store/orders',
		payload: { product: 'p1', amount: 9.99 },
	});
	assert.equal(validOrder.statusCode, 201);
	assert.match(validOrder.json().id, /^ord_\d+$/);
	assert.equal(validOrder.json().product, 'p1');
	assert.ok(validOrder.json().createdAt);

	// Action handlers are deliberately fire-and-forget; yield once before assertions.
	await setImmediate();

	const analytics = await runtime.app.inject({ method: 'GET', url: '/store/analytics' });
	assert.equal(analytics.statusCode, 200);
	assert.deepEqual(analytics.json(), { orders: 1, revenue: 9.99 });

	const audit = await runtime.app.inject({ method: 'GET', url: '/audit/log' });
	assert.equal(audit.statusCode, 200);
	assert.equal(audit.json().length, 1);
	assert.equal(audit.json()[0].event, 'order.created');

	const health = await runtime.app.inject({ method: 'GET', url: '/health' });
	assert.equal(health.statusCode, 200);
	assert.deepEqual(health.json(), { status: 'ok' });

	const disabled = await runtime.app.inject({ method: 'GET', url: '/disabled-feature/status' });
	assert.equal(disabled.statusCode, 404);

	console.log('✓ consumer example: discovery and host enablement');
	console.log('✓ consumer example: two-phase hook + endpoint loading');
	console.log('✓ consumer example: filter/action event pipeline');
	console.log('✓ consumer example: sealed cross-extension service registry');
	console.log('✓ consumer example: bundle endpoints and wildcard actions');
	console.log('✓ consumer example: cleanup and schedule shutdown');
} finally {
	await runtime.close();
}
