/**
 * `@codihaus/fastify-extensions` — manifest-based extension system for Fastify.
 *
 * Layout:
 * - `types.ts`  — authoring surface, also published as the `./types` subpath
 * - `kernel/`   — extension microkernel: discovery, loading, manager, service registry
 * - `runtime/`  — shared runtime: event emitter, cron scheduling, console logger
 * - `plugin/`   — one-phase Fastify plugin wrapper around the manager
 * - `kit/`      — app kit: `ServerExtension.start()` builds a full Fastify app
 *
 * Extension authors should import only from `@codihaus/fastify-extensions/types`.
 */

// Type surface + define helpers + createServiceRef (also published under ./types).
export * from './types.js';

// Extension kernel.
export { ExtensionManager, type ExtensionManagerOptions } from './kernel/manager.js';
export { ServiceRegistryImpl } from './kernel/registry.js';
export { validateManifest, type ManifestValidation } from './kernel/discovery.js';

// Shared runtime.
export { Emitter, type EmitterOptions } from './runtime/emitter.js';
export { MemoryScheduleLock, scheduleCronJob, validateCron, type ScheduledJob } from './runtime/schedule.js';
export { createConsoleLogger } from './runtime/logger.js';

// Fastify plugin wrapper.
export { fastifyExtensions, type FastifyExtensionsOptions } from './plugin/fastify-extensions.js';

// App kit.
export * from './kit/index.js';
