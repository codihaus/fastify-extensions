import type { FastifyBaseLogger } from 'fastify';

/**
 * Shutdown order after the HTTP server stopped taking requests (mirrors ODP core):
 *   workers     — queue workers finish (or hand back) the job in hand
 *   schedules   — cron jobs stop (extension schedules stop here too)
 *   connections — Redis/DB clients close last, after everything that uses them
 */
export const SHUTDOWN_PHASES = ['workers', 'schedules', 'connections'] as const;
export type ShutdownPhase = (typeof SHUTDOWN_PHASES)[number];

interface ShutdownHook {
	phase: ShutdownPhase;
	name: string;
	run: () => void | Promise<void>;
}

/**
 * Phased shutdown hooks. Hooks of one phase run in parallel; a hook that throws or
 * outlives the timeout is logged and skipped, never blocking the others.
 */
export class ShutdownRegistry {
	private readonly hooks = new Set<ShutdownHook>();
	private running: Promise<void> | undefined;

	constructor(
		private readonly logger: FastifyBaseLogger,
		private readonly timeoutMs: number,
	) {}

	/** Register a hook. Returns a function that unregisters it. */
	add(phase: ShutdownPhase, name: string, run: () => void | Promise<void>): () => void {
		if (!SHUTDOWN_PHASES.includes(phase)) {
			throw new Error(`Unknown shutdown phase "${phase}" — use one of ${SHUTDOWN_PHASES.join(', ')}.`);
		}
		const hook: ShutdownHook = { phase, name, run };
		this.hooks.add(hook);
		return () => {
			this.hooks.delete(hook);
		};
	}

	/** Run every registered hook once, phase by phase. Later calls return the same run. */
	run(): Promise<void> {
		this.running ??= (async () => {
			for (const phase of SHUTDOWN_PHASES) {
				const due = [...this.hooks].filter((hook) => hook.phase === phase);
				for (const hook of due) this.hooks.delete(hook);
				if (due.length === 0) continue;

				this.logger.info({ phase, hooks: due.map((hook) => hook.name) }, `Shutdown: ${phase}`);
				await Promise.all(due.map((hook) => this.runHook(hook)));
			}
		})();
		return this.running;
	}

	private async runHook(hook: ShutdownHook): Promise<void> {
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<'timeout'>((resolve) => {
			timer = setTimeout(() => resolve('timeout'), this.timeoutMs);
			timer.unref();
		});

		try {
			const outcome = await Promise.race([Promise.resolve().then(hook.run).then(() => 'done' as const), timeout]);
			if (outcome === 'timeout') {
				this.logger.warn({ hook: hook.name, phase: hook.phase, timeoutMs: this.timeoutMs }, 'Shutdown hook timed out — moving on');
			}
		} catch (error) {
			this.logger.error({ err: error, hook: hook.name, phase: hook.phase }, 'Shutdown hook failed');
		} finally {
			clearTimeout(timer);
		}
	}
}
