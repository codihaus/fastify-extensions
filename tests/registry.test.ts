import { describe, expect, it } from 'vitest';
import { ServiceRegistryImpl, createServiceRef } from '../src/index.js';
import type { ExtensionLoggerLike } from '../src/index.js';

interface FakeLogger extends ExtensionLoggerLike {
	debugCalls: Array<[unknown, string?]>;
	infoCalls: Array<[unknown, string?]>;
	warnCalls: Array<[unknown, string?]>;
	errorCalls: Array<[unknown, string?]>;
}

function createFakeLogger(): FakeLogger {
	const logger: FakeLogger = {
		debugCalls: [],
		infoCalls: [],
		warnCalls: [],
		errorCalls: [],
		debug(obj: unknown, msg?: string): void {
			logger.debugCalls.push([obj, msg]);
		},
		info(obj: unknown, msg?: string): void {
			logger.infoCalls.push([obj, msg]);
		},
		warn(obj: unknown, msg?: string): void {
			logger.warnCalls.push([obj, msg]);
		},
		error(obj: unknown, msg?: string): void {
			logger.errorCalls.push([obj, msg]);
		},
		child(): ExtensionLoggerLike {
			return logger;
		},
	};
	return logger;
}

interface FakeService {
	greet(): string;
}

describe('ServiceRegistryImpl', () => {
	it('provide then consume returns the impl (typed round-trip, no cast)', () => {
		const logger = createFakeLogger();
		const registry = new ServiceRegistryImpl(logger);
		const ref = createServiceRef<FakeService>('greeter');
		const impl: FakeService = { greet: () => 'hello' };

		registry.provide(ref, impl);
		const consumed = registry.consume(ref);

		expect(consumed.greet()).toBe('hello');
		expect(consumed).toBe(impl);
	});

	it('has(id) returns true after provide', () => {
		const logger = createFakeLogger();
		const registry = new ServiceRegistryImpl(logger);
		const ref = createServiceRef<FakeService>('greeter');

		expect(registry.has('greeter')).toBe(false);
		registry.provide(ref, { greet: () => 'hi' });
		expect(registry.has('greeter')).toBe(true);
	});

	it('tryConsume before seal returns undefined and warns exactly once per id', () => {
		const logger = createFakeLogger();
		const registry = new ServiceRegistryImpl(logger);
		const ref = createServiceRef<FakeService>('missing-service');

		const first = registry.tryConsume(ref);
		const second = registry.tryConsume(ref);

		expect(first).toBeUndefined();
		expect(second).toBeUndefined();
		expect(logger.warnCalls.length).toBe(1);
	});

	it('consume of a missing id before seal throws the "consumed before registry sealed" message', () => {
		const logger = createFakeLogger();
		const registry = new ServiceRegistryImpl(logger);
		const ref = createServiceRef<FakeService>('missing-service');

		expect(() => registry.consume(ref)).toThrow('consumed before registry sealed');
	});

	it('after seal(): consume of a missing id throws the "No provider" sealed message', () => {
		const logger = createFakeLogger();
		const registry = new ServiceRegistryImpl(logger);
		const ref = createServiceRef<FakeService>('missing-service');

		registry.seal();

		expect(() => registry.consume(ref)).toThrow('No provider');
	});

	it('after seal(): tryConsume of a missing id returns undefined without erroring', () => {
		const logger = createFakeLogger();
		const registry = new ServiceRegistryImpl(logger);
		const ref = createServiceRef<FakeService>('missing-service');

		registry.seal();
		const result = registry.tryConsume(ref);

		expect(result).toBeUndefined();
		expect(logger.errorCalls.length).toBe(0);
	});

	it('double provide logs an override warning', () => {
		const logger = createFakeLogger();
		const registry = new ServiceRegistryImpl(logger);
		const ref = createServiceRef<FakeService>('greeter');

		registry.provide(ref, { greet: () => 'first' });
		registry.provide(ref, { greet: () => 'second' });

		expect(logger.warnCalls.length).toBe(1);
		expect(logger.warnCalls[0][1]).toContain('already provided');
	});

	it('provide after seal logs a warning', () => {
		const logger = createFakeLogger();
		const registry = new ServiceRegistryImpl(logger);
		const ref = createServiceRef<FakeService>('greeter');

		registry.seal();
		registry.provide(ref, { greet: () => 'late' });

		expect(logger.warnCalls.length).toBe(1);
		expect(logger.warnCalls[0][1]).toContain('after registry sealed');
	});
});
