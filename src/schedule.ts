import { CronJob, validateCronExpression } from 'cron';
import type { ExtensionLoggerLike, ScheduleLock } from './types.js';

/** Handle to a running scheduled job. */
export interface ScheduledJob {
	/** Stop the job and release its lock state. */
	stop(): Promise<void>;
}

/**
 * Default single-instance schedule lock. It always claims the tick, which is the
 * correct behaviour when the host runs exactly one instance. Cluster deployments
 * back {@link ScheduleLock} with Redis/DB so only one instance runs each tick.
 */
export class MemoryScheduleLock implements ScheduleLock {
	async claim(_name: string, _timestamp: number): Promise<boolean> {
		return true;
	}

	async release(_name: string): Promise<void> {
		// Nothing to release for the in-memory lock.
	}
}

/**
 * Validate a standard 5-field cron expression (minute hour day-of-month month day-of-week).
 */
export function validateCron(rule: string): boolean {
	return validateCronExpression(rule).valid;
}

/**
 * Schedule a cron job coordinated through a {@link ScheduleLock}.
 *
 * On each tick the job computes the next tick timestamp (deterministic across
 * instances) and asks the lock to claim `(name, timestamp)`. Only the instance that
 * wins the claim runs the handler. Handler and lock errors are logged, never thrown.
 */
export function scheduleCronJob(
	name: string,
	cron: string,
	handler: () => void | Promise<void>,
	scheduleLock: ScheduleLock,
	logger: ExtensionLoggerLike,
): ScheduledJob {
	const job = CronJob.from({
		cronTime: cron,
		onTick: async () => {
			const nextTimestamp = job.nextDate().toMillis();

			let claimed: boolean;
			try {
				claimed = await scheduleLock.claim(name, nextTimestamp);
			} catch (error) {
				logger.error({ name, cron, error }, `Schedule lock claim failed for "${name}"`);
				return;
			}

			if (!claimed) {
				return;
			}

			try {
				await handler();
			} catch (error) {
				logger.error({ name, cron, error }, `Schedule handler error for "${name}"`);
			}
		},
		start: true,
	});

	logger.debug({ name, cron }, 'Scheduled job registered');

	return {
		async stop() {
			job.stop();
			try {
				await scheduleLock.release(name);
			} catch (error) {
				logger.error({ name, error }, `Schedule lock release failed for "${name}"`);
			}
			logger.debug({ name }, 'Scheduled job stopped');
		},
	};
}
