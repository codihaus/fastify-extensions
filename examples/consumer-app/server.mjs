import { createConsoleLogger } from '@codihaus/fastify-extensions';
import { buildApp } from './app.mjs';

const port = Number(process.env.PORT ?? 3100);
const logger = createConsoleLogger({ app: 'consumer-app' });
const runtime = await buildApp({ logger });

try {
	await runtime.app.listen({ port, host: '127.0.0.1' });
	logger.info({ port }, 'consumer-app listening');
} catch (error) {
	logger.error({ error }, 'consumer-app failed to listen');
	await runtime.close();
	throw error;
}

let shuttingDown = false;
const shutdown = async (signal) => {
	if (shuttingDown) return;
	shuttingDown = true;
	logger.info({ signal }, 'consumer-app shutting down');
	await runtime.close();
};

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.once(signal, () => {
		shutdown(signal).catch((error) => {
			logger.error({ error }, 'consumer-app shutdown failed');
			process.exitCode = 1;
		});
	});
}
