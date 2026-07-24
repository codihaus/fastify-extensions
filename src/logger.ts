import type { ExtensionLoggerLike } from './types.js';

/**
 * Console-backed fallback logger used when the host does not inject one.
 *
 * It honours the same `(obj, msg?)` signature as pino: the first argument is a
 * structured object (or a message string) and the optional second argument is a
 * human-readable message. `child(bindings)` merges the bindings into every record.
 */
class ConsoleLogger implements ExtensionLoggerLike {
	constructor(private readonly bindings: Record<string, unknown> = {}) {}

	debug(obj: unknown, msg?: string): void {
		this.write('debug', obj, msg);
	}

	info(obj: unknown, msg?: string): void {
		this.write('info', obj, msg);
	}

	warn(obj: unknown, msg?: string): void {
		this.write('warn', obj, msg);
	}

	error(obj: unknown, msg?: string): void {
		this.write('error', obj, msg);
	}

	child(bindings: Record<string, unknown>): ExtensionLoggerLike {
		return new ConsoleLogger({ ...this.bindings, ...bindings });
	}

	private write(level: 'debug' | 'info' | 'warn' | 'error', obj: unknown, msg?: string): void {
		const record = this.buildRecord(obj, msg);
		const sink = level === 'debug' ? console.debug : console[level];
		if (record.message !== undefined) {
			sink(`[fastify-extensions] ${record.message}`, record.fields);
		} else {
			sink('[fastify-extensions]', record.fields);
		}
	}

	private buildRecord(obj: unknown, msg?: string): { message: string | undefined; fields: Record<string, unknown> } {
		if (typeof obj === 'string') {
			return { message: obj, fields: this.bindings };
		}
		if (obj !== null && typeof obj === 'object') {
			return { message: msg, fields: { ...this.bindings, ...(obj as Record<string, unknown>) } };
		}
		return { message: msg, fields: { ...this.bindings, value: obj } };
	}
}

/**
 * Create the default console-backed logger. Pass optional root bindings that appear
 * on every record it emits.
 */
export function createConsoleLogger(bindings: Record<string, unknown> = {}): ExtensionLoggerLike {
	return new ConsoleLogger(bindings);
}
