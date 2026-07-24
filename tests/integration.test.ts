import { describe, expect, it } from 'vitest';
import { default as fastify } from 'fastify';
import {
	createServiceRef,
	ExtensionManager,
	type ExtensionLoggerLike,
} from '../src/index.js';

const FIXTURES_PATH = new URL('./fixtures/local', import.meta.url).pathname;
const MANIFEST_KEY = 'test-extension';

interface TestContext {
	id: string;
	marks: string[];
	actions: string[];
}

/** A fake logger capturing every call, with `child` returning the same instance. */
function createFakeLogger(): ExtensionLoggerLike & { calls: Array<{ level: string; obj: unknown; msg?: string }> } {
	const calls: Array<{ level: string; obj: unknown; msg?: string }> = [];
	const logger: ExtensionLoggerLike & { calls: typeof calls } = {
		calls,
		debug(obj: unknown, msg?: string) {
			calls.push({ level: 'debug', obj, msg });
		},
		info(obj: unknown, msg?: string) {
			calls.push({ level: 'info', obj, msg });
		},
		warn(obj: unknown, msg?: string) {
			calls.push({ level: 'warn', obj, msg });
		},
		error(obj: unknown, msg?: string) {
			calls.push({ level: 'error', obj, msg });
		},
		child() {
			return logger;
		},
	};
	return logger;
}

describe('integration — end-to-end demo (REQUIREMENTS §11.2)', () => {
	it('boots a real fastify app with hook-basic, endpoint-basic and bundle-full, and serves routes end-to-end', async () => {
		const logger = createFakeLogger();
		const contexts = new Map<string, TestContext>();

		const manager = new ExtensionManager<TestContext>({
			manifestKey: MANIFEST_KEY,
			extensionsPath: FIXTURES_PATH,
			moduleRoot: false,
			logger,
			createContext: (config) => {
				const existing = contexts.get(config.id);
				if (existing) {
					return existing;
				}
				const created: TestContext = { id: config.id, marks: [], actions: [] };
				contexts.set(config.id, created);
				return created;
			},
		});

		await manager.scanAndLoadHooks();

		const app = fastify();
		await manager.loadEndpoints(app);
		await app.ready();

		try {
			// hook-basic wrote its init marker into the injected context.
			expect(contexts.get('hook-basic')?.marks).toEqual(['hook-basic:init']);

			// endpoint-basic mounted GET /ping under its own id prefix.
			const pingResponse = await app.inject({ method: 'GET', url: '/endpoint-basic/ping' });
			expect(pingResponse.statusCode).toBe(200);
			expect(pingResponse.json()).toEqual({ ok: true, id: 'endpoint-basic' });

			// bundle-full mounted `endpoints` under /billing (first endpoint entry) and
			// `endpoint_extra` under /extra.
			const billingResponse = await app.inject({ method: 'GET', url: '/billing/status' });
			expect(billingResponse.statusCode).toBe(200);
			expect(billingResponse.json()).toEqual({ scope: 'billing' });

			const extraResponse = await app.inject({ method: 'GET', url: '/extra/info' });
			expect(extraResponse.statusCode).toBe(200);
			expect(extraResponse.json()).toEqual({ scope: 'extra' });

			// hook-basic's filter + action ran through the manager's shared emitter.
			const eventContext = { actions: [] as string[] };
			const filtered = await manager.emitter.emitFilter('items.create', { title: 'hello' }, {}, eventContext);
			expect(filtered).toEqual({ title: 'hello', hooked: true });

			manager.emitter.emitAction('items.create', {}, eventContext);
			await new Promise((resolve) => setImmediate(resolve));
			expect(eventContext.actions).toEqual(['items.create']);

			// The three primary fixtures loaded successfully (the local fixtures directory
			// also contains disabled/custom-entry, which load fine, and broken-import,
			// which fails Phase 1 and is logged, not thrown, since it is not in mustLoad).
			const loadedIds = manager.getExtensions().map((config) => config.id).sort();
			expect(loadedIds).toEqual(expect.arrayContaining(['bundle-full', 'endpoint-basic', 'hook-basic']));
			expect(loadedIds).not.toContain('broken-import');

			const errorLogs = logger.calls.filter((call) => call.level === 'error');
			expect(errorLogs.some((call) => JSON.stringify(call.obj).includes('broken-import'))).toBe(true);
		} finally {
			await app.close();
			await manager.reset();
		}
	});
});

describe('integration — cross-extension registry window (§6.1, §5.8)', () => {
	it('lets a provider registered during extensions.register be consumed only after loadEndpoints seals the registry', async () => {
		const logger = createFakeLogger();

		const manager = new ExtensionManager<TestContext>({
			manifestKey: MANIFEST_KEY,
			extensionsPath: undefined,
			moduleRoot: false,
			logger,
			createContext: (config) => ({ id: config.id, marks: [], actions: [] }),
		});

		interface GreetingService {
			greet(): string;
		}
		const greetingRef = createServiceRef<GreetingService>('greeting-service');

		// Simulate a provider extension: it attaches to the manager's own emitter and
		// provides during the 'extensions.register' init event, exactly as a real hook
		// extension's `hook.init('extensions.register', ...)` would.
		manager.emitter.onInit('extensions.register', () => {
			manager.registry.provide(greetingRef, { greet: () => 'hello' });
		});

		// Registry is not sealed yet, and nothing has been provided yet either.
		expect(manager.registry.has(greetingRef.id)).toBe(false);
		expect(manager.registry.tryConsume(greetingRef)).toBeUndefined();
		const preSealWarnings = logger.calls.filter((call) => call.level === 'warn').length;
		expect(preSealWarnings).toBeGreaterThan(0);

		await manager.scanAndLoadHooks();

		const app = fastify();
		await manager.loadEndpoints(app);
		await app.ready();

		try {
			// After loadEndpoints: the register event fired, the provider ran, and the
			// registry is now sealed.
			expect(manager.registry.has(greetingRef.id)).toBe(true);
			expect(manager.registry.consume(greetingRef).greet()).toBe('hello');

			// consume() of a missing ref after sealing throws the "sealed" message.
			const missingRef = createServiceRef<unknown>('missing-service');
			expect(() => manager.registry.consume(missingRef)).toThrowError(
				/No provider for service "missing-service"/,
			);
		} finally {
			await app.close();
			await manager.reset();
		}
	});

	it('warns once on a pre-seal tryConsume and does not re-warn on a second pre-seal miss for the same id', async () => {
		const logger = createFakeLogger();

		const manager = new ExtensionManager<TestContext>({
			manifestKey: MANIFEST_KEY,
			extensionsPath: undefined,
			moduleRoot: false,
			logger,
			createContext: (config) => ({ id: config.id, marks: [], actions: [] }),
		});

		const ref = createServiceRef<unknown>('never-provided');

		expect(manager.registry.tryConsume(ref)).toBeUndefined();
		expect(manager.registry.tryConsume(ref)).toBeUndefined();

		const warningsForRef = logger.calls.filter(
			(call) => call.level === 'warn' && typeof call.obj === 'object' && call.obj !== null && (call.obj as { id?: string }).id === 'never-provided',
		);
		expect(warningsForRef).toHaveLength(1);
	});
});
