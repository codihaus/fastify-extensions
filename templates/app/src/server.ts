import { ServerExtension } from '@codihaus/fastify-extensions';
import { appOptions } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();

await ServerExtension.start({
	...appOptions(config),
	port: config.port,
	// Use HOST=0.0.0.0 in containers.
	host: config.host,
});
