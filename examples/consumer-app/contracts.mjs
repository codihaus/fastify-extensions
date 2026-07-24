// Shared contract module: both the PROVIDER (analytics extension) and the CONSUMER
// (store extension) import the SAME service ref from here. The runtime key is the
// string id; the type parameter (in TypeScript hosts) carries the service shape.
import { createServiceRef } from '@codihaus/fastify-extensions/types';

/**
 * @typedef {Object} AnalyticsService
 * @property {() => { orders: number, revenue: number }} snapshot
 */

/** @type {import('@codihaus/fastify-extensions/types').ServiceRef<AnalyticsService>} */
export const analyticsRef = createServiceRef('analytics-service');
