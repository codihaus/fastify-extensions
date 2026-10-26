import type { FastifyInstance } from 'fastify';

/** Add `x-response-time` (ms) to every reply. */
export function responseTime(app: FastifyInstance): void {
	app.addHook('onSend', async (_request, reply) => {
		reply.header('x-response-time', reply.elapsedTime.toFixed(1));
	});
}
