import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppConfig {
	name: string;
	env: string;
	port: number;
	host: string;
	logLevel: string;
	/** Folder that holds views/, public/ and extensions/: the project root in dev, dist/ after build. */
	root: string;
}

/** Read settings from environment variables. Add new settings here, not in feature code. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
	return {
		name: '__APP_NAME__',
		env: env['NODE_ENV'] ?? 'development',
		port: Number(env['PORT'] ?? 3000),
		host: env['HOST'] ?? '127.0.0.1',
		logLevel: env['LOG_LEVEL'] ?? 'info',
		root: join(dirname(fileURLToPath(import.meta.url)), '..'),
	};
}
