import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { default as fastify } from 'fastify';
import { ExtensionManager, fastifyExtensions } from '../src/index.js';
import type { ExtensionConfig, ExtensionLoggerLike, FastifyExtensionsOptions } from '../src/index.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const localFixtures = join(currentDir, 'fixtures/local');

interface TestContext {
	id: string;
	marks: string[];
	actions: string[];
}

function createFakeLogger(): ExtensionLoggerLike {
	const logger: ExtensionLoggerLike = {
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		child: () => logger,
	};
	return logger;
}

function makeCreateContext() {
	const contexts: Record<string, TestContext> = {};
	return (config: ExtensionConfig): TestContext => {
		if (!contexts[config.id]) {
			contexts[config.id] = { id: config.id, marks: [], actions: [] };
		}
		return contexts[config.id];
	};
}

describe('fastifyExtensions plugin', () => {
	it('mounts endpoint extension routes under the registration scope', async () => {
		const app = fastify();
		await app.register(fastifyExtensions, {
			manifestKey: 'test-extension',
			extensionsPath: localFixtures,
			moduleRoot: false,
			logger: createFakeLogger(),
			createContext: makeCreateContext(),
		});
		await app.ready();

		const response = await app.inject({ method: 'GET', url: '/endpoint-basic/ping' });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ ok: true, id: 'endpoint-basic' });

		await app.close();
	});

	// `fastifyExtensions` is deliberately NOT wrapped with `fastify-plugin` (see
	// REQUIREMENTS.md 5.5), so a decorator it sets via `app.register(fastifyExtensions, ...)`
	// lives on the encapsulated child context Fastify creates for that registration and is
	// not visible on the outer `app` reference. Calling the exported plugin function directly
	// (a fully supported usage of a plain async function) decorates the SAME instance the
	// test holds, which is the only way to observe `app.extensions` on that instance.
	it('decorates the instance with the ExtensionManager as app.extensions', async () => {
		const app = fastify();
		await fastifyExtensions(app, {
			manifestKey: 'test-extension',
			extensionsPath: localFixtures,
			moduleRoot: false,
			logger: createFakeLogger(),
			createContext: makeCreateContext(),
		});
		await app.ready();

		expect(app.extensions).toBeInstanceOf(ExtensionManager);
		expect(typeof app.extensions.getExtensions).toBe('function');
		expect(app.extensions.getExtensions().length).toBeGreaterThan(0);

		await app.close();
	});

	// The documented way to obtain the manager when using `app.register()`: the
	// decorator stays inside the encapsulated scope, so the outer app.extensions is
	// undefined and `onManager` hands the instance out instead.
	it('register() + onManager exposes the manager while keeping the decorator scoped', async () => {
		const app = fastify();
		let received: ExtensionManager<TestContext> | undefined;

		const options: FastifyExtensionsOptions<TestContext> = {
			manifestKey: 'test-extension',
			extensionsPath: localFixtures,
			moduleRoot: false,
			logger: createFakeLogger(),
			createContext: makeCreateContext(),
			onManager: (manager) => {
				received = manager;
			},
		};
		await app.register(fastifyExtensions, options);
		await app.ready();

		expect(received).toBeInstanceOf(ExtensionManager);
		expect(received?.getExtensions().length).toBeGreaterThan(0);
		// Encapsulation: the outer instance is NOT decorated.
		expect(app.extensions).toBeUndefined();

		const response = await app.inject({ method: 'GET', url: '/endpoint-basic/ping' });
		expect(response.statusCode).toBe(200);

		await app.close();
		// onClose ran reset() on the scoped manager.
		expect(received?.getExtensions()).toEqual([]);
	});

	it('resets the manager on app.close via the onClose hook', async () => {
		const app = fastify();
		await fastifyExtensions(app, {
			manifestKey: 'test-extension',
			extensionsPath: localFixtures,
			moduleRoot: false,
			logger: createFakeLogger(),
			createContext: makeCreateContext(),
		});
		await app.ready();

		expect(app.extensions.getExtensions().length).toBeGreaterThan(0);

		await app.close();

		expect(app.extensions.getExtensions()).toEqual([]);
	});
});

describe('fastifyExtensions plugin — review 2026-10-24', () => {
	const shapeFixtures = join(currentDir, 'fixtures/shapes');

	it('I — resets the manager when boot fails, so started schedules do not leak', async () => {
		const released: string[] = [];
		const app = fastify();

		await expect(
			fastifyExtensions(app, {
				manifestKey: 'test-extension',
				extensionsPath: shapeFixtures,
				moduleRoot: false,
				logger: createFakeLogger(),
				isEnabled: (id) => id === 'dup-cron',
				mustLoad: ['missing-extension'],
				scheduleLock: {
					claim: async () => true,
					release: async (name) => {
						released.push(name);
					},
				},
				createContext: makeCreateContext(),
			}),
		).rejects.toThrow('Required extension "missing-extension" failed to load');

		expect(released).toHaveLength(3);
		await app.close();
	});

	it('H — a second direct registration keeps the first decorator and warns instead of throwing', async () => {
		const warnings: string[] = [];
		const logger: ExtensionLoggerLike = { ...createFakeLogger(), warn: (_obj, msg) => void warnings.push(String(msg)) };
		const app = fastify();
		const managers: ExtensionManager<TestContext>[] = [];
		const options = {
			manifestKey: 'test-extension',
			extensionsPath: localFixtures,
			moduleRoot: false as const,
			logger,
			isEnabled: (id: string) => id === 'hook-basic',
			createContext: makeCreateContext(),
			onManager: (manager: ExtensionManager<TestContext>) => void managers.push(manager),
		};

		await fastifyExtensions(app, options);
		await fastifyExtensions(app, options);

		expect(managers).toHaveLength(2);
		expect(app.extensions).toBe(managers[0]);
		expect(warnings.some((message) => message.includes('already decorated'))).toBe(true);
		await app.close();
	});
});
