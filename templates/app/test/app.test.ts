import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { ServerExtension } from '@codihaus/fastify-extensions';
import { appOptions } from '../src/app.js';
import type { AppContext } from '../src/contracts.js';

let kit: ServerExtension<AppContext>;

before(async () => {
	// create() builds the app without listening or installing signal handlers.
	kit = await ServerExtension.create({ ...appOptions(), fastify: { logger: false } });
});

after(() => kit.close());

test('loads the extensions', () => {
	assert.deepEqual(kit.extensions.map((extension) => extension.id).sort(), ['audit', 'reports']);
});

test('renders the home page', async () => {
	const response = await kit.app.inject({ method: 'GET', url: '/' });
	assert.equal(response.statusCode, 200);
	assert.match(response.body, /Notebook/);
});

test('serves static files', async () => {
	const response = await kit.app.inject({ method: 'GET', url: '/public/css/app.css' });
	assert.equal(response.statusCode, 200);
});

test('rejects an invalid product', async () => {
	const response = await kit.app.inject({ method: 'POST', url: '/api/products', payload: { name: '   ', price: 1 } });
	assert.equal(response.statusCode, 400);
	assert.equal(response.json().code, 'INVALID_PRODUCT');
});

test('creates a product through the extension filter and action', async () => {
	const response = await kit.app.inject({ method: 'POST', url: '/api/products', payload: { name: '  Pen  ', price: 2 } });
	assert.equal(response.statusCode, 201);
	assert.equal(response.json().name, 'Pen');

	// Actions are fire-and-forget: let the audit handler run.
	await setImmediate();
	const summary = await kit.app.inject({ method: 'GET', url: '/reports/summary' });
	assert.equal(summary.json().auditEntries, 1);
});

test('returns 404 for a missing product', async () => {
	const response = await kit.app.inject({ method: 'GET', url: '/api/products/999' });
	assert.equal(response.statusCode, 404);
});

test('is ready', async () => {
	const response = await kit.app.inject({ method: 'GET', url: '/health/ready' });
	assert.equal(response.statusCode, 200);
});
