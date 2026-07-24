import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { default as fastify } from 'fastify';
import type { ExtensionConfig, ExtensionLoggerLike, ExtensionManagerOptions } from '../src/index.js';
import { ExtensionManager } from '../src/index.js';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const LOCAL_FIXTURES = join(CURRENT_DIR, 'fixtures', 'local');
const MANIFEST_KEY = 'test-extension';

interface TestContext {
	id: string;
	marks: string[];
	actions: string[];
}

interface FakeLogCall {
	level: 'debug' | 'info' | 'warn' | 'error';
	obj: unknown;
	msg: string | undefined;
}

interface FakeLogger {
	logger: ExtensionLoggerLike;
	calls: FakeLogCall[];
}

function createFakeLogger(): FakeLogger {
	const calls: FakeLogCall[] = [];
	const logger: ExtensionLoggerLike = {
		debug(obj, msg) {
			calls.push({ level: 'debug', obj, msg });
		},
		info(obj, msg) {
			calls.push({ level: 'info', obj, msg });
		},
		warn(obj, msg) {
			calls.push({ level: 'warn', obj, msg });
		},
		error(obj, msg) {
			calls.push({ level: 'error', obj, msg });
		},
		child() {
			return logger;
		},
	};
	return { logger, calls };
}

interface BootedManager {
	manager: ExtensionManager<TestContext>;
	app: ReturnType<typeof fastify>;
	contexts: Record<string, TestContext>;
	contextCallCounts: Record<string, number>;
	logger: FakeLogger;
}

/** Construct a manager scoped to the local fixtures and run both boot phases. */
async function bootManager(
	overrides: Partial<ExtensionManagerOptions<TestContext>> = {},
): Promise<BootedManager> {
	const contexts: Record<string, TestContext> = {};
	const contextCallCounts: Record<string, number> = {};
	const logger = createFakeLogger();

	const manager = new ExtensionManager<TestContext>({
		manifestKey: MANIFEST_KEY,
		extensionsPath: LOCAL_FIXTURES,
		moduleRoot: false,
		logger: logger.logger,
		createContext: (config: ExtensionConfig) => {
			contextCallCounts[config.id] = (contextCallCounts[config.id] ?? 0) + 1;
			if (!contexts[config.id]) {
				contexts[config.id] = { id: config.id, marks: [], actions: [] };
			}
			return contexts[config.id];
		},
		...overrides,
	});

	await manager.scanAndLoadHooks();
	const app = fastify();
	await manager.loadEndpoints(app);
	await app.ready();

	return { manager, app, contexts, contextCallCounts, logger };
}

describe('ExtensionManager', () => {
	it('Phase 1 registers hooks but defers endpoint mounting', async () => {
		const logger = createFakeLogger();
		const manager = new ExtensionManager<TestContext>({
			manifestKey: MANIFEST_KEY,
			extensionsPath: LOCAL_FIXTURES,
			moduleRoot: false,
			logger: logger.logger,
			createContext: (config) => ({ id: config.id, marks: [], actions: [] }),
		});

		await manager.scanAndLoadHooks();

		const result = await manager.emitter.emitFilter('items.create', { count: 1 }, {}, {});
		expect(result).toEqual({ count: 1, hooked: true });

		const app = fastify();
		await app.ready();
		const response = await app.inject({ method: 'GET', url: '/endpoint-basic/ping' });
		expect(response.statusCode).toBe(404);

		await app.close();
	});

	it('Phase 2 mounts endpoint extensions on the given fastify instance', async () => {
		const { app } = await bootManager();

		const response = await app.inject({ method: 'GET', url: '/endpoint-basic/ping' });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ ok: true, id: 'endpoint-basic' });

		await app.close();
	});

	it('mounts bundle endpoint entries under their declared prefixes', async () => {
		const { app } = await bootManager();

		const billingResponse = await app.inject({ method: 'GET', url: '/billing/status' });
		expect(billingResponse.statusCode).toBe(200);
		expect(billingResponse.json()).toEqual({ scope: 'billing' });

		const extraResponse = await app.inject({ method: 'GET', url: '/extra/info' });
		expect(extraResponse.statusCode).toBe(200);
		expect(extraResponse.json()).toEqual({ scope: 'extra' });

		await app.close();
	});

	it('calls createContext exactly once per loaded extension and threads the same instance through', async () => {
		const { app, contexts, contextCallCounts } = await bootManager();

		expect(contextCallCounts['hook-basic']).toBe(1);
		expect(contextCallCounts['bundle-full']).toBe(1);
		expect(contextCallCounts['endpoint-basic']).toBe(1);

		// hook-basic pushes a mark using the context injected into its hook function;
		// seeing it here proves the SAME object instance created by createContext
		// reached the extension.
		expect(contexts['hook-basic']?.marks).toContain('hook-basic:init');
		expect(contexts['bundle-full']?.marks).toContain('bundle-full:hooks');

		await app.close();
	});

	it('passes the raw package.json and config to onManifest once per loaded extension', async () => {
		const manifestCalls: Array<{ pkg: Record<string, unknown>; config: ExtensionConfig }> = [];
		const { app } = await bootManager({
			onManifest: (pkg, config) => {
				manifestCalls.push({ pkg, config });
			},
		});

		const hookBasicCall = manifestCalls.find((call) => call.config.id === 'hook-basic');
		expect(hookBasicCall).toBeDefined();
		expect(hookBasicCall?.pkg.name).toBe('hook-basic');
		expect(hookBasicCall?.pkg.version).toBe('1.0.0');

		const loadedIds = ['hook-basic', 'endpoint-basic', 'bundle-full', 'disabled', 'custom-entry'];
		for (const id of loadedIds) {
			const callsForId = manifestCalls.filter((call) => call.config.id === id);
			expect(callsForId.length).toBe(1);
		}

		// broken-import fails at Phase 1 and never reaches Phase 2, so onManifest
		// must never be called for it.
		expect(manifestCalls.some((call) => call.config.id === 'broken-import')).toBe(false);

		await app.close();
	});

	it('discovers a disabled extension but skips loading it', async () => {
		const logger = createFakeLogger();
		const manager = new ExtensionManager<TestContext>({
			manifestKey: MANIFEST_KEY,
			extensionsPath: LOCAL_FIXTURES,
			moduleRoot: false,
			logger: logger.logger,
			isEnabled: (id) => id !== 'disabled',
			createContext: (config) => ({ id: config.id, marks: [], actions: [] }),
		});

		const discovered = await manager.scanExtensions();
		expect(discovered.some((config) => config.id === 'disabled')).toBe(true);

		await manager.scanAndLoadHooks();

		const result = await manager.emitter.emitFilter('disabled.event', { untouched: true }, {}, {});
		expect(result).toEqual({ untouched: true });
	});

	it('mustLoad makes scanAndLoadHooks throw for a missing required id, logging otherwise', async () => {
		const strictLogger = createFakeLogger();
		const strictManager = new ExtensionManager<TestContext>({
			manifestKey: MANIFEST_KEY,
			extensionsPath: LOCAL_FIXTURES,
			moduleRoot: false,
			logger: strictLogger.logger,
			mustLoad: ['broken-import'],
			createContext: (config) => ({ id: config.id, marks: [], actions: [] }),
		});

		await expect(strictManager.scanAndLoadHooks()).rejects.toThrow(/broken-import/);

		const lenientLogger = createFakeLogger();
		const lenientManager = new ExtensionManager<TestContext>({
			manifestKey: MANIFEST_KEY,
			extensionsPath: LOCAL_FIXTURES,
			moduleRoot: false,
			logger: lenientLogger.logger,
			createContext: (config) => ({ id: config.id, marks: [], actions: [] }),
		});

		await expect(lenientManager.scanAndLoadHooks()).resolves.toBeUndefined();

		const errorCall = lenientLogger.calls.find(
			(call) => call.level === 'error' && (call.obj as { id?: string }).id === 'broken-import',
		);
		expect(errorCall).toBeDefined();
	});

	it('unloadExtension runs cleanups and stops a previously registered filter from firing', async () => {
		const { manager, app } = await bootManager();

		const before = await manager.emitter.emitFilter('items.create', { count: 1 }, {}, {});
		expect(before).toEqual({ count: 1, hooked: true });

		const unloaded = await manager.unloadExtension('hook-basic');
		expect(unloaded).toBe(true);

		const after = await manager.emitter.emitFilter('items.create', { count: 1 }, {}, {});
		expect(after).toEqual({ count: 1 });

		const unknown = await manager.unloadExtension('does-not-exist');
		expect(unknown).toBe(false);

		await app.close();
	});

	it('reset() is idempotent and clears all loaded extensions', async () => {
		const { manager, app } = await bootManager();

		expect(manager.getExtensions().length).toBeGreaterThan(0);

		await manager.reset();
		expect(manager.getExtensions()).toEqual([]);

		await expect(manager.reset()).resolves.toBeUndefined();
		expect(manager.getExtensions()).toEqual([]);

		await app.close();
	});
});
