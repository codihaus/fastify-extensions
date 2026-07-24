import { describe, expect, it, vi } from 'vitest';
import { Emitter, type ExtensionLoggerLike } from '../src/index.js';

interface FakeLogger extends ExtensionLoggerLike {
	calls: { level: string; obj: unknown; msg: string | undefined }[];
}

function createFakeLogger(): FakeLogger {
	const calls: { level: string; obj: unknown; msg: string | undefined }[] = [];
	const logger: FakeLogger = {
		calls,
		debug(obj: unknown, msg?: string): void {
			calls.push({ level: 'debug', obj, msg });
		},
		info(obj: unknown, msg?: string): void {
			calls.push({ level: 'info', obj, msg });
		},
		warn(obj: unknown, msg?: string): void {
			calls.push({ level: 'warn', obj, msg });
		},
		error(obj: unknown, msg?: string): void {
			calls.push({ level: 'error', obj, msg });
		},
		child(): ExtensionLoggerLike {
			return logger;
		},
	};
	return logger;
}

describe('Emitter', () => {
	it('runs the filter pipeline sequentially in registration order, threading payload', async () => {
		const emitter = new Emitter<Record<string, unknown>>();
		const order: number[] = [];

		emitter.onFilter<{ counter: number }>('items.create', (payload) => {
			order.push(1);
			return { counter: payload.counter + 1 };
		});
		emitter.onFilter<{ counter: number }>('items.create', (payload) => {
			order.push(2);
			return { counter: payload.counter * 10 };
		});

		const result = await emitter.emitFilter('items.create', { counter: 1 }, {}, {});

		expect(order).toEqual([1, 2]);
		expect(result).toEqual({ counter: 20 });
	});

	it('rejects emitFilter when a filter handler throws', async () => {
		const emitter = new Emitter<Record<string, unknown>>();
		const failure = new Error('filter boom');

		emitter.onFilter('items.create', () => {
			throw failure;
		});

		await expect(emitter.emitFilter('items.create', { value: 1 }, {}, {})).rejects.toThrow(failure);
	});

	it('runs action handlers and swallows/logs their errors, returning void synchronously', async () => {
		const logger = createFakeLogger();
		const emitter = new Emitter<Record<string, unknown>>({ logger });
		const failure = new Error('action boom');
		const seen: string[] = [];

		emitter.onAction('items.create', () => {
			seen.push('first');
		});
		emitter.onAction('items.create', async () => {
			throw failure;
		});

		const result = emitter.emitAction('items.create', {}, {});

		expect(result).toBeUndefined();
		expect(seen).toEqual(['first']);

		await vi.waitFor(() => {
			expect(logger.calls.some((call) => call.level === 'error')).toBe(true);
		});

		const errorCall = logger.calls.find((call) => call.level === 'error');
		expect(errorCall?.obj).toMatchObject({ event: 'items.create', error: failure });
	});

	it('runs init handlers sequentially and awaits each before the next starts', async () => {
		const emitter = new Emitter<Record<string, unknown>>();
		const order: string[] = [];

		emitter.onInit('extensions.register', async () => {
			order.push('start-first');
			await new Promise((resolve) => setTimeout(resolve, 10));
			order.push('end-first');
		});
		emitter.onInit('extensions.register', async () => {
			order.push('start-second');
			await new Promise((resolve) => setTimeout(resolve, 1));
			order.push('end-second');
		});

		await emitter.emitInit('extensions.register');

		expect(order).toEqual(['start-first', 'end-first', 'start-second', 'end-second']);
	});

	it('offFilter/offAction/offInit remove a previously registered handler', async () => {
		const emitter = new Emitter<Record<string, unknown>>();

		const filterHandler = vi.fn((payload: { value: number }) => payload);
		const actionHandler = vi.fn();
		const initHandler = vi.fn();

		emitter.onFilter('items.create', filterHandler);
		emitter.onAction('items.create', actionHandler);
		emitter.onInit('extensions.register', initHandler);

		emitter.offFilter('items.create', filterHandler);
		emitter.offAction('items.create', actionHandler);
		emitter.offInit('extensions.register', initHandler);

		await emitter.emitFilter('items.create', { value: 1 }, {}, {});
		emitter.emitAction('items.create', {}, {});
		await emitter.emitInit('extensions.register');

		expect(filterHandler).not.toHaveBeenCalled();
		expect(actionHandler).not.toHaveBeenCalled();
		expect(initHandler).not.toHaveBeenCalled();
	});

	it('matches an exact event pattern against emitFilter', async () => {
		const emitter = new Emitter<Record<string, unknown>>();
		const handler = vi.fn((payload: { value: number }) => payload);

		emitter.onFilter('items.create', handler);

		await emitter.emitFilter('items.create', { value: 1 }, {}, {});

		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('matches the wildcard "*" pattern against any event on emitFilter', async () => {
		const emitter = new Emitter<Record<string, unknown>>();
		const handler = vi.fn((payload: { value: number }) => payload);

		emitter.onFilter('*', handler);

		await emitter.emitFilter('articles.items.create', { value: 1 }, {}, {});

		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('matches a prefix wildcard pattern "items.*" against "items.create" on emitFilter', async () => {
		const emitter = new Emitter<Record<string, unknown>>();
		const handler = vi.fn((payload: { value: number }) => payload);

		emitter.onFilter('items.*', handler);

		await emitter.emitFilter('items.create', { value: 1 }, {}, {});

		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('matches a suffix wildcard pattern "*.items.create" against "articles.items.create" on emitFilter', async () => {
		const emitter = new Emitter<Record<string, unknown>>();
		const handler = vi.fn((payload: { value: number }) => payload);

		emitter.onFilter('*.items.create', handler);

		await emitter.emitFilter('articles.items.create', { value: 1 }, {}, {});

		expect(handler).toHaveBeenCalledTimes(1);
	});
});
