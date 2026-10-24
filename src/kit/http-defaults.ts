import { randomUUID } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Kit defaults for `Fastify()`, overridden by the host's own `fastify` options. */
export function resolveFastifyOptions(userOptions: FastifyServerOptions = {}, requestId: boolean): FastifyServerOptions {
	const defaults: FastifyServerOptions = {};

	// Fastify 5 rejects `logger` together with `loggerInstance`.
	if (userOptions.logger === undefined && userOptions.loggerInstance === undefined) {
		defaults.logger = { level: 'info' };
	}
	if (requestId) {
		defaults.genReqId = (request) => {
			const header = request.headers['x-request-id'];
			return typeof header === 'string' && REQUEST_ID_PATTERN.test(header) ? header : randomUUID();
		};
	}

	return { ...defaults, ...userOptions };
}

/** Echo the request id on every reply. */
export function echoRequestId(app: FastifyInstance): void {
	app.addHook('onRequest', async (request, reply) => {
		reply.header('x-request-id', request.id);
	});
}

/** Fastify 5 rejects an empty JSON body; SDKs often POST without one. */
export function acceptEmptyJsonBody(app: FastifyInstance): void {
	app.removeContentTypeParser('application/json');
	app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
		const text = (body as string).trim();
		if (!text) {
			done(null, undefined);
			return;
		}
		try {
			done(null, JSON.parse(text));
		} catch (error) {
			const parseError = error as FastifyError;
			parseError.statusCode = 400;
			done(parseError, undefined);
		}
	});
}

export function defaultErrorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
	const statusCode = typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
	if (statusCode >= 500) {
		request.log.error({ err: error }, 'Request failed');
	}
	void reply.code(statusCode).send({
		statusCode,
		error: STATUS_CODES[statusCode] ?? 'Error',
		code: error.code,
		// Internal details stay in the log, never in an anonymous response.
		message: statusCode >= 500 ? 'Internal Server Error' : error.message,
	});
}

export function defaultNotFoundHandler(request: FastifyRequest, reply: FastifyReply): void {
	// The query string can carry tokens — keep it out of the response.
	const path = request.url.split('?')[0];
	void reply.code(404).send({
		statusCode: 404,
		error: 'Not Found',
		code: 'ROUTE_NOT_FOUND',
		message: `Route ${request.method} ${path} not found`,
	});
}
