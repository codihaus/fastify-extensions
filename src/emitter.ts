import type {
	ActionHandler,
	ExtensionLoggerLike,
	FilterHandler,
	InitHandler,
	ScheduleLock,
} from './types.js';
import { MemoryScheduleLock, scheduleCronJob, validateCron, type ScheduledJob } from './schedule.js';
import { createConsoleLogger } from './logger.js';

interface HandlerEntry<THandler> {
	event: string;
	handler: THandler;
}

interface ScheduleEntry {
	name: string;
	cron: string;
	job: ScheduledJob;
}

/** Options for constructing an {@link Emitter}. */
export interface EmitterOptions {
	/** Logger for internal diagnostics. Defaults to a console-backed logger. */
	logger?: ExtensionLoggerLike;
	/** Coordinates schedule ticks across instances. Defaults to {@link MemoryScheduleLock}. */
	scheduleLock?: ScheduleLock;
}

/**
 * Three-tier event system with cron scheduling.
 *
 * - **filter** — sequential, transforming pipeline; a thrown error propagates.
 * - **action** — parallel, fire-and-forget; errors are logged, never thrown.
 * - **init** — sequential, awaited; a thrown error propagates.
 *
 * The generic `TEventContext` is the host-defined value passed to filter and action
 * handlers. Unlike ODP's emitter, there is no module-level singleton — the host owns
 * instance lifetime.
 */
export class Emitter<TEventContext = unknown> {
	private filters: HandlerEntry<FilterHandler<any, TEventContext>>[] = [];
	private actions: HandlerEntry<ActionHandler<TEventContext>>[] = [];
	private inits: HandlerEntry<InitHandler>[] = [];
	private schedules: ScheduleEntry[] = [];
	private readonly logger: ExtensionLoggerLike;
	private readonly scheduleLock: ScheduleLock;

	constructor(options: EmitterOptions = {}) {
		this.logger = options.logger ?? createConsoleLogger({ name: 'emitter' });
		this.scheduleLock = options.scheduleLock ?? new MemoryScheduleLock();
	}

	// ── Register / unregister ─────────────────────────────────────────────────

	onFilter<TPayload = unknown>(event: string, handler: FilterHandler<TPayload, TEventContext>): void {
		this.filters.push({ event, handler: handler as FilterHandler<any, TEventContext> });
	}

	offFilter<TPayload = unknown>(event: string, handler: FilterHandler<TPayload, TEventContext>): void {
		this.filters = this.filters.filter(
			(entry) => !(entry.event === event && entry.handler === handler),
		);
	}

	onAction(event: string, handler: ActionHandler<TEventContext>): void {
		this.actions.push({ event, handler });
	}

	offAction(event: string, handler: ActionHandler<TEventContext>): void {
		this.actions = this.actions.filter(
			(entry) => !(entry.event === event && entry.handler === handler),
		);
	}

	onInit(event: string, handler: InitHandler): void {
		this.inits.push({ event, handler });
	}

	offInit(event: string, handler: InitHandler): void {
		this.inits = this.inits.filter(
			(entry) => !(entry.event === event && entry.handler === handler),
		);
	}

	// ── Emit ──────────────────────────────────────────────────────────────────

	/**
	 * FILTER — runs matching handlers SEQUENTIALLY, threading each handler's output
	 * into the next, and returns the final payload. Accepts one event or an array of
	 * events (processed in array order). A handler error propagates to the caller.
	 *
	 * The `event` key of the handler meta is reserved: it always carries the actual
	 * emitted event name and cannot be overridden by caller-provided meta.
	 */
	async emitFilter<TPayload>(
		event: string | string[],
		payload: TPayload,
		meta: Record<string, unknown>,
		context: TEventContext,
	): Promise<TPayload> {
		const events = Array.isArray(event) ? event : [event];
		let current = payload;

		for (const singleEvent of events) {
			const handlers = this.getMatchingHandlers(this.filters, singleEvent);
			for (const entry of handlers) {
				try {
					current = (await entry.handler(current, { ...meta, event: singleEvent }, context)) as TPayload;
				} catch (error) {
					this.logger.error({ event: singleEvent, error }, `Filter handler error for "${singleEvent}"`);
					throw error;
				}
			}
		}

		return current;
	}

	/**
	 * ACTION — runs all matching handlers IN PARALLEL without awaiting them. Errors —
	 * whether thrown synchronously or from a rejected promise — are caught per handler
	 * and logged; `emitAction` never throws and a failed handler never prevents the
	 * remaining handlers from starting.
	 *
	 * The `event` meta key is reserved, same as {@link emitFilter}.
	 */
	emitAction(
		event: string | string[],
		meta: Record<string, unknown>,
		context: TEventContext,
	): void {
		const events = Array.isArray(event) ? event : [event];

		for (const singleEvent of events) {
			const handlers = this.getMatchingHandlers(this.actions, singleEvent);
			for (const entry of handlers) {
				try {
					Promise.resolve(entry.handler({ ...meta, event: singleEvent }, context)).catch((error) => {
						this.logger.error({ event: singleEvent, error }, `Action handler error for "${singleEvent}"`);
					});
				} catch (error) {
					// A synchronous throw must not escape the fire-and-forget boundary.
					this.logger.error({ event: singleEvent, error }, `Action handler error for "${singleEvent}"`);
				}
			}
		}
	}

	/**
	 * INIT — runs matching handlers SEQUENTIALLY, awaiting each. A handler error
	 * propagates to the caller.
	 */
	async emitInit(event: string, meta: Record<string, unknown> = {}): Promise<void> {
		const handlers = this.getMatchingHandlers(this.inits, event);

		for (const entry of handlers) {
			try {
				await entry.handler(meta);
			} catch (error) {
				this.logger.error({ event, error }, `Init handler error for "${event}"`);
				throw error;
			}
		}
	}

	// ── Pattern matching ────────────────────────────────────────────────────────

	private getMatchingHandlers<THandler>(
		handlers: HandlerEntry<THandler>[],
		event: string,
	): HandlerEntry<THandler>[] {
		return handlers.filter((entry) => this.matchEvent(entry.event, event));
	}

	/**
	 * Match an event against a subscription pattern:
	 * - exact: `items.create` matches `items.create`
	 * - `*`: matches any event
	 * - prefix wildcard `items.*`: matches `items.create`, `items.update`
	 * - suffix wildcard `*.create`: matches `items.create`, `articles.items.create`
	 *
	 * Wildcards are dot-segment-bounded: `*.create` does NOT match `recreate` or
	 * `items.recreate`. (This deliberately tightens the ODP behaviour, which matched
	 * on a bare substring — see DEVIATIONS.md.)
	 */
	private matchEvent(pattern: string, event: string): boolean {
		if (pattern === event) {
			return true;
		}
		if (pattern === '*') {
			return true;
		}
		if (pattern.endsWith('.*')) {
			const prefix = pattern.slice(0, -2);
			if (event.startsWith(prefix + '.')) {
				return true;
			}
		}
		if (pattern.startsWith('*.')) {
			const suffix = pattern.slice(2);
			if (event.endsWith('.' + suffix)) {
				return true;
			}
		}
		return false;
	}

	// ── Schedules ────────────────────────────────────────────────────────────────

	/**
	 * Register a cron schedule. Returns an unregister function that stops the job;
	 * awaiting its returned promise waits for the job stop and the ScheduleLock
	 * release to complete. An invalid cron expression logs a warning and returns a
	 * no-op unregister.
	 */
	addSchedule(name: string, cron: string, handler: () => Promise<void>): () => Promise<void> {
		if (!validateCron(cron)) {
			this.logger.warn({ name, cron }, `Invalid cron expression for schedule "${name}", skipping`);
			return async () => {};
		}

		const job = scheduleCronJob(name, cron, handler, this.scheduleLock, this.logger);
		const entry: ScheduleEntry = { name, cron, job };
		this.schedules.push(entry);

		return () => {
			this.schedules = this.schedules.filter((candidate) => candidate !== entry);
			return entry.job.stop();
		};
	}

	/** Stop and remove every scheduled job. */
	async stopAllSchedules(): Promise<void> {
		await Promise.all(this.schedules.map((entry) => entry.job.stop()));
		this.schedules = [];
	}

	/** Clear all handlers and stop all schedules. */
	async reset(): Promise<void> {
		this.filters = [];
		this.actions = [];
		this.inits = [];
		await this.stopAllSchedules();
	}
}
