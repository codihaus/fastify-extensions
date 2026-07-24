import type { ExtensionLoggerLike, ServiceRef, ServiceRegistry } from './types.js';

/**
 * Cross-extension service registry.
 *
 * Extension A provides a live service; extension B (or an endpoint/hook) consumes it.
 * Providers register during the `extensions.register` init event; the manager then
 * seals the registry before any consumer runs.
 *
 * Discipline is self-diagnosing: a `tryConsume` that runs before the registry is
 * sealed (e.g. at a hook's top level) degrades to "absent" and logs once per id, so
 * the mistake surfaces on the first dev boot instead of silently misbehaving.
 */
export class ServiceRegistryImpl implements ServiceRegistry {
	private readonly services = new Map<string, unknown>();
	private ready = false;
	private readonly warnedIds = new Set<string>();

	constructor(private readonly logger: ExtensionLoggerLike) {}

	provide<T>(ref: ServiceRef<T>, impl: T): void {
		if (this.ready) {
			this.logger.warn({ id: ref.id }, `provide("${ref.id}") after registry sealed — consumers may have already missed it`);
		}
		if (this.services.has(ref.id)) {
			this.logger.warn({ id: ref.id }, `service "${ref.id}" already provided — overriding`);
		}
		this.services.set(ref.id, impl);
	}

	consume<T>(ref: ServiceRef<T>): T {
		const hit = this.services.get(ref.id);
		if (hit !== undefined) {
			return hit as T;
		}
		throw new Error(
			this.ready
				? `No provider for service "${ref.id}" (is the providing extension installed and enabled?)`
				: `Service "${ref.id}" consumed before registry sealed — move consume into a request handler or a hook that runs after 'extensions.register'`,
		);
	}

	tryConsume<T>(ref: ServiceRef<T> | string): T | undefined {
		const id = typeof ref === 'string' ? ref : ref.id;
		const hit = this.services.get(id);
		if (hit !== undefined) {
			return hit as T;
		}

		if (!this.ready) {
			if (!this.warnedIds.has(id)) {
				this.warnedIds.add(id);
				this.logger.warn(
					{ id, stack: new Error().stack },
					`Service "${id}" consumed before load finished — move consume into a request handler / post-'extensions.register' hook`,
				);
			}
			return undefined;
		}

		this.logger.debug({ id }, `no provider registered for "${id}" (optional)`);
		return undefined;
	}

	has(id: string): boolean {
		return this.services.has(id);
	}

	/** Internal: mark loading complete. Called once by the manager after `extensions.register`. */
	seal(): void {
		this.ready = true;
	}

	/** Internal: whether the registry has been sealed. */
	get sealed(): boolean {
		return this.ready;
	}

	/** Internal: clear all state so a manager can be reused. */
	reset(): void {
		this.services.clear();
		this.ready = false;
		this.warnedIds.clear();
	}
}
