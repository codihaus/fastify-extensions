// Shared contract between the host and its extensions: the context type and the
// service refs. Extensions import from here, never from one another.
import { createServiceRef, type AppKitBaseContext } from '@codihaus/fastify-extensions';
import type { AppConfig } from './config.js';
import type { AppServices } from './services/index.js';

/** What every extension receives: the kit base context plus host resources. */
export interface AppContext extends AppKitBaseContext {
	appConfig: AppConfig;
	services: AppServices;
}

export interface AuditEntry {
	event: string;
	at: string;
	data: unknown;
}

/** Provided by the audit extension, consumed by the reports extension. */
export interface AuditService {
	list(): AuditEntry[];
}

export const auditRef = createServiceRef<AuditService>('audit');
