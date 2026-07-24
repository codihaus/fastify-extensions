// Regression tests for the defects raised in CODE_AUDIT.md (2026-07-21).
// Each describe block maps to one confirmed finding.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { default as fastify } from 'fastify';
import { Emitter, ExtensionManager } from '../src/index.js';
import type { ExtensionConfig, ExtensionLoggerLike } from '../src/index.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const localFixtures = join(currentDir, 'fixtures/local');
const dupFixtures = join(currentDir, 'fixtures/dup-local');
const shapeFixtures = join(currentDir, 'fixtures/shapes');

interface LogCall {
	level: 'debug' | 'info' | 'warn' | 'error';
	obj: unknown;
	msg: string | undefined;
}

interface FakeLogger extends ExtensionLoggerLike {
	calls: LogCall[];
}

function createFakeLogger(): FakeLogger {
	const calls: LogCall[] = [];
	const logger: FakeLogger = {
		calls,
		debug: (obj, msg) => calls.push({ level: 'debug', obj, msg }),
		info: (obj, msg) => calls.push({ level: 'info', obj, msg }),
		warn: (obj, msg) => calls.push({ level: 'warn', obj, msg }),
		error: (obj, msg) => calls.push({ level: 'error', obj, msg }),
		child: () => logger,
	};
	return logger;
}

function makeManager(extensionsPath: string, logger: FakeLogger, overrides: Record<string, unknown> = {}) {
	return new ExtensionManager<{ id: string }>({
		manifestKey: 'test-extension',
		extensionsPath,
		moduleRoot: false,
		logger,
		createContext: (config: ExtensionConfig) => ({ id: config.id }),
		...overrides,
	});
}

describe('P0 — synchronous action errors stay inside the fire-and-forget boundary', () => {
	it('logs a synchronous throw and does not let emitAction throw', () => {
		const logger = createFakeLogger();
		const emitter = new Emitter({ logger });
		const secondHandlerRuns: string[] = [];

		emitter.onAction('boom', () => {
			throw new Error('synchronous failure');
		});
		emitter.onAction('boom', () => {
			secondHandlerRuns.push('ran');
		});

		expect(() => emitter.emitAction('boom', {}, {})).not.toThrow();
		expect(secondHandlerRuns).toEqual(['ran']);
		const errorLogs = logger.calls.filter((call) => call.level === 'error');
		expect(errorLogs).toHaveLength(1);
	});

	it('still logs asynchronous rejections', async () => {
		const logger = createFakeLogger();
		const emitter = new Emitter({ logger });

		emitter.onAction('boom', async () => {
			throw new Error('asynchronous failure');
		});

		emitter.emitAction('boom', {}, {});
		await new Promise((resolveTick) => setTimeout(resolveTick, 0));

		expect(logger.calls.filter((call) => call.level === 'error')).toHaveLength(1);
	});
});

describe('P1 — the `event` meta key is reserved for the emitter', () => {
	it('filter handlers receive the real event name despite a spoofed meta.event', async () => {
		const emitter = new Emitter();
		let seenEvent: unknown;

		emitter.onFilter('real.event', (payload, meta) => {
			seenEvent = meta['event'];
			return payload;
		});

		await emitter.emitFilter('real.event', {}, { event: 'spoofed' }, {});
		expect(seenEvent).toBe('real.event');
	});

	it('action handlers receive the real event name despite a spoofed meta.event', async () => {
		const emitter = new Emitter();
		let seenEvent: unknown;

		emitter.onAction('real.event', (meta) => {
			seenEvent = meta['event'];
		});

		emitter.emitAction('real.event', { event: 'spoofed' }, {});
		await new Promise((resolveTick) => setTimeout(resolveTick, 0));
		expect(seenEvent).toBe('real.event');
	});
});

describe('P1 — suffix wildcards are dot-segment-bounded', () => {
	async function matches(pattern: string, event: string): Promise<boolean> {
		const emitter = new Emitter();
		let fired = false;
		emitter.onFilter(pattern, (payload) => {
			fired = true;
			return payload;
		});
		await emitter.emitFilter(event, {}, {}, {});
		return fired;
	}

	it('*.create matches dot-bounded events', async () => {
		expect(await matches('*.create', 'items.create')).toBe(true);
		expect(await matches('*.items.create', 'articles.items.create')).toBe(true);
	});

	it('*.create does not match bare or partial suffixes', async () => {
		expect(await matches('*.create', 'recreate')).toBe(false);
		expect(await matches('*.create', 'items.recreate')).toBe(false);
	});

	it('*.items does not match a mid-string segment', async () => {
		expect(await matches('*.items', 'a.items.create')).toBe(false);
		expect(await matches('*.items', 'a.items')).toBe(true);
	});
});

describe('P0 — lifecycle guards prevent double registration', () => {
	it('scanAndLoadHooks throws when called twice without reset', async () => {
		const logger = createFakeLogger();
		const manager = makeManager(localFixtures, logger, { isEnabled: (id: string) => id === 'hook-basic' });

		await manager.scanAndLoadHooks();
		await expect(manager.scanAndLoadHooks()).rejects.toThrow(/may only run once/);

		await manager.reset();
		// After reset a fresh cycle is allowed again.
		await expect(manager.scanAndLoadHooks()).resolves.toBeUndefined();
		await manager.reset();
	});

	it('loadEndpoints requires Phase 1 and refuses to run twice', async () => {
		const logger = createFakeLogger();
		const manager = makeManager(localFixtures, logger, { isEnabled: (id: string) => id === 'endpoint-basic' });
		const app = fastify();

		await expect(manager.loadEndpoints(app)).rejects.toThrow(/before scanAndLoadHooks/);

		await manager.scanAndLoadHooks();
		await manager.loadEndpoints(app);
		await expect(manager.loadEndpoints(app)).rejects.toThrow(/already ran/);

		await app.close();
		await manager.reset();
	});

	it('reset() removes every handler registered by a load cycle (no ghosts)', async () => {
		const logger = createFakeLogger();
		const emitter = new Emitter<{ id?: string }>({ logger });
		const manager = makeManager(localFixtures, logger, {
			emitter,
			isEnabled: (id: string) => id === 'hook-basic',
		});
		const app = fastify();

		await manager.scanAndLoadHooks();
		await manager.loadEndpoints(app);
		await manager.reset();

		const untouched = await emitter.emitFilter('items.create', { probe: true }, {}, {});
		expect(untouched).toEqual({ probe: true });

		await app.close();
	});
});

describe('P0 — duplicate ids within one source are rejected deterministically', () => {
	it('keeps the alphabetically-first local candidate and logs an error for the duplicate', async () => {
		const logger = createFakeLogger();
		const emitter = new Emitter({ logger });
		const manager = makeManager(dupFixtures, logger, { emitter });

		const discovered = await manager.scanExtensions();
		expect(discovered.map((config) => config.id)).toEqual(['dup-ext']);
		expect(discovered[0]?.folder).toBe('aaa-first');

		const duplicateErrors = logger.calls.filter(
			(call) => call.level === 'error' && String(call.msg).includes('Duplicate extension id'),
		);
		expect(duplicateErrors).toHaveLength(1);

		await manager.scanAndLoadHooks();
		const filtered = await emitter.emitFilter('dup.event', {}, {}, {});
		expect(filtered).toEqual({ winner: 'aaa-first' });

		await manager.reset();
	});
});

describe('P1 — load results are truthful', () => {
	it('an unrecognized module shape is skipped, never reported loaded', async () => {
		const logger = createFakeLogger();
		const manager = makeManager(shapeFixtures, logger, { isEnabled: (id: string) => id === 'unknown-shape' });
		const app = fastify();

		await manager.scanAndLoadHooks();
		await manager.loadEndpoints(app);

		expect(manager.getExtensions()).toEqual([]);
		const shapeWarnings = logger.calls.filter(
			(call) => call.level === 'warn' && String(call.msg).includes('Unrecognized extension shape'),
		);
		expect(shapeWarnings).toHaveLength(1);

		await app.close();
		await manager.reset();
	});

	it('an endpoint extension whose setup throws is discarded, others continue', async () => {
		const logger = createFakeLogger();
		const manager = makeManager(shapeFixtures, logger, {
			isEnabled: (id: string) => id === 'endpoint-fail' || id === 'async-hook',
		});
		const app = fastify();

		await manager.scanAndLoadHooks();
		await manager.loadEndpoints(app);
		await app.ready();

		const loadedIds = manager.getExtensions().map((config) => config.id);
		expect(loadedIds).toEqual(['async-hook']);

		const endpointErrors = logger.calls.filter(
			(call) => call.level === 'error' && String(call.msg).includes('Phase 2'),
		);
		expect(endpointErrors).toHaveLength(1);

		// The Fastify instance stays healthy (avvio not poisoned): the app serves 404s
		// normally and the partially-mounted route remains (documented limitation).
		const partial = await app.inject({ method: 'GET', url: '/endpoint-fail/before-crash' });
		expect(partial.statusCode).toBe(200);

		await app.close();
		await manager.reset();
	});

	it('async hook setup is awaited — registrations after an await are visible', async () => {
		const logger = createFakeLogger();
		const emitter = new Emitter({ logger });
		const manager = makeManager(shapeFixtures, logger, {
			emitter,
			isEnabled: (id: string) => id === 'async-hook',
		});

		await manager.scanAndLoadHooks();
		const filtered = await emitter.emitFilter('async.event', {}, {}, {});
		expect(filtered).toEqual({ asyncRegistered: true });

		await manager.reset();
	});
});

describe('P1 — extensions.register failure is terminal but sealed', () => {
	it('propagates the init error, still seals the registry, and cannot re-fire init handlers', async () => {
		const logger = createFakeLogger();
		const manager = makeManager(localFixtures, logger, { isEnabled: () => false });
		const app = fastify();

		let initRuns = 0;
		manager.emitter.onInit('extensions.register', () => {
			initRuns += 1;
			throw new Error('register handler failure');
		});

		await manager.scanAndLoadHooks();
		await expect(manager.loadEndpoints(app)).rejects.toThrow('register handler failure');
		expect(initRuns).toBe(1);

		// Registry sealed despite the failure: a missing consume reports the sealed message.
		expect(() => manager.registry.consume({ id: 'missing' })).toThrow(/No provider/);

		// The load sequence is terminal — a retry throws instead of re-firing init side effects.
		await expect(manager.loadEndpoints(app)).rejects.toThrow(/already ran/);
		expect(initRuns).toBe(1);

		await app.close();
		await manager.reset();
	});
});
