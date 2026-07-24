import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Emitter, MemoryScheduleLock, validateCron } from '../src/index.js';
import type { ExtensionLoggerLike, ScheduleLock } from '../src/index.js';

interface FakeLoggerCall {
	obj: unknown;
	msg: string | undefined;
}

interface FakeLogger extends ExtensionLoggerLike {
	debugCalls: FakeLoggerCall[];
	infoCalls: FakeLoggerCall[];
	warnCalls: FakeLoggerCall[];
	errorCalls: FakeLoggerCall[];
}

function createFakeLogger(): FakeLogger {
	const logger: FakeLogger = {
		debugCalls: [],
		infoCalls: [],
		warnCalls: [],
		errorCalls: [],
		debug(obj: unknown, msg?: string): void {
			logger.debugCalls.push({ obj, msg });
		},
		info(obj: unknown, msg?: string): void {
			logger.infoCalls.push({ obj, msg });
		},
		warn(obj: unknown, msg?: string): void {
			logger.warnCalls.push({ obj, msg });
		},
		error(obj: unknown, msg?: string): void {
			logger.errorCalls.push({ obj, msg });
		},
		child(): ExtensionLoggerLike {
			return logger;
		},
	};
	return logger;
}

class AlwaysDenyScheduleLock implements ScheduleLock {
	async claim(_name: string, _timestamp: number): Promise<boolean> {
		return false;
	}

	async release(_name: string): Promise<void> {
		// Nothing to release.
	}
}

describe('validateCron', () => {
	it('returns true for a valid cron expression', () => {
		expect(validateCron('*/5 * * * *')).toBe(true);
	});

	it('returns false for an invalid cron expression', () => {
		expect(validateCron('not a cron')).toBe(false);
	});
});

describe('MemoryScheduleLock', () => {
	it('claim() resolves true', async () => {
		const lock = new MemoryScheduleLock();
		await expect(lock.claim('job', Date.now())).resolves.toBe(true);
	});
});

describe('Emitter.addSchedule', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('fires the handler when timers advance to the next minute', async () => {
		const logger = createFakeLogger();
		const emitter = new Emitter({ logger });
		const handler = vi.fn(async () => {});

		emitter.addSchedule('every-minute', '*/1 * * * *', handler);

		await vi.advanceTimersByTimeAsync(60000);

		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('invalid cron logs a warn and returns a no-op unregister; handler never fires', async () => {
		const logger = createFakeLogger();
		const emitter = new Emitter({ logger });
		const handler = vi.fn(async () => {});

		const unregister = emitter.addSchedule('bad-job', 'not a cron', handler);

		expect(logger.warnCalls).toHaveLength(1);
		expect(logger.warnCalls[0]?.obj).toMatchObject({ name: 'bad-job', cron: 'not a cron' });

		await vi.advanceTimersByTimeAsync(60000);

		expect(handler).not.toHaveBeenCalled();
		expect(() => unregister()).not.toThrow();
	});

	it('the unregister function stops the job', async () => {
		const logger = createFakeLogger();
		const emitter = new Emitter({ logger });
		const handler = vi.fn(async () => {});

		const unregister = emitter.addSchedule('stoppable', '*/1 * * * *', handler);

		await vi.advanceTimersByTimeAsync(60000);
		expect(handler).toHaveBeenCalledTimes(1);

		unregister();

		await vi.advanceTimersByTimeAsync(60000);
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('a ScheduleLock whose claim() resolves false prevents the handler from running', async () => {
		const logger = createFakeLogger();
		const scheduleLock = new AlwaysDenyScheduleLock();
		const emitter = new Emitter({ logger, scheduleLock });
		const handler = vi.fn(async () => {});

		emitter.addSchedule('denied-job', '*/1 * * * *', handler);

		await vi.advanceTimersByTimeAsync(60000);

		expect(handler).not.toHaveBeenCalled();
	});
});
