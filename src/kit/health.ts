import type { FastifyBaseLogger, onRequestHookHandler } from 'fastify';

/** Readiness / liveness probes, answered before any host or extension hook runs. */
export interface AppKitHealthOptions {
	/** Base path. Default `/health`: `GET /health`, `/health/live`, `/health/ready`. */
	path?: string;
	/** Dependency checks for `/ready`. A check that throws or times out fails readiness. */
	checks?: Record<string, () => unknown | Promise<unknown>>;
	/** Per-check timeout. Default 3000 ms. */
	timeoutMs?: number;
}

const DEFAULT_CHECK_TIMEOUT_MS = 3_000;

/**
 * Probes answered at onRequest, before auth / rate-limit hooks a probe must not
 * depend on (ODP A-12):
 *   GET <path>, <path>/live — the process serves HTTP
 *   GET <path>/ready        — every check passes and `isServing()` is true;
 *                             503 otherwise. Which check failed goes to the log only.
 * Concurrent readiness requests share the check in flight.
 */
export function createHealthProbe(
	options: AppKitHealthOptions,
	isServing: () => boolean,
	logger: FastifyBaseLogger,
): onRequestHookHandler {
	const basePath = (options.path ?? '/health').replace(/\/+$/, '');
	const livePaths = new Set([basePath, `${basePath}/live`]);
	const readyPath = `${basePath}/ready`;
	const checks = Object.entries(options.checks ?? {});
	const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
	let readinessInFlight: Promise<boolean> | null = null;

	const runCheck = async (name: string, check: () => unknown): Promise<boolean> => {
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				Promise.resolve().then(check),
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error(`${name} check timed out after ${timeoutMs}ms`)), timeoutMs);
				}),
			]);
			return true;
		} catch (error) {
			logger.warn({ err: error, check: name }, 'Readiness check failed');
			return false;
		} finally {
			clearTimeout(timer);
		}
	};

	const checkReadiness = (): Promise<boolean> => {
		readinessInFlight ??= Promise.all(checks.map(([name, check]) => runCheck(name, check)))
			.then((results) => results.every(Boolean))
			.finally(() => {
				readinessInFlight = null;
			});
		return readinessInFlight;
	};

	return async (request, reply) => {
		if (request.method !== 'GET' && request.method !== 'HEAD') return;
		const path = request.url.split('?')[0] ?? '';

		if (livePaths.has(path)) {
			return reply.send({ status: 'ok' });
		}

		if (path === readyPath) {
			const ready = isServing() && (await checkReadiness());
			return reply.code(ready ? 200 : 503).send({ status: ready ? 'ok' : 'error' });
		}
	};
}
