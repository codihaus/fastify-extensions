import type { FastifyInstance } from 'fastify';
import { responseTime } from './response-time.js';

/** Global hooks, applied to host routes and extension endpoints alike (auth, rate limit, ...). */
export function registerMiddlewares(app: FastifyInstance): void {
	responseTime(app);
}
