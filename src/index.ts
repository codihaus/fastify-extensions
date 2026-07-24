/**
 * `@codihaus/fastify-extensions` — manifest-based extension system for Fastify.
 *
 * This barrel exposes the full runtime surface (manager, emitter, registry, schedule
 * lock, logger, plugin) plus everything from the `./types` subpath. Extension authors
 * should import only from `@codihaus/fastify-extensions/types`.
 */

// Type surface + define helpers + createServiceRef (also published under ./types).
export * from './types.js';

// Runtime classes and helpers.
export { Emitter, type EmitterOptions } from './emitter.js';
export { ServiceRegistryImpl } from './registry.js';
export { MemoryScheduleLock, scheduleCronJob, validateCron, type ScheduledJob } from './schedule.js';
export { createConsoleLogger } from './logger.js';
export { validateManifest, type ManifestValidation } from './discovery.js';
export { ExtensionManager, type ExtensionManagerOptions } from './manager.js';
export { fastifyExtensions, type FastifyExtensionsOptions } from './plugin.js';
