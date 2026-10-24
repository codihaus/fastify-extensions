import { ServerExtension } from '@codihaus/fastify-extensions';
import { appOptions } from './app.js';

await ServerExtension.start({
	...appOptions(),
	port: Number(process.env.PORT ?? 3200),
	host: process.env.HOST ?? '127.0.0.1',
});
