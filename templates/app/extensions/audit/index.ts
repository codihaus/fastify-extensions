// Hook extension: shapes product drafts (filter), records created products
// (action), shares the log as a service, and trims it on a schedule.
import { defineHook } from '@codihaus/fastify-extensions/types';
import { auditRef, type AppContext, type AuditEntry } from '../../src/contracts.js';
import type { NewProduct } from '../../src/models/product.model.js';

const MAX_ENTRIES = 1000;

export default defineHook<AppContext>((hook, context) => {
	const entries: AuditEntry[] = [];

	// The only place to provide services: the registry seals right after this event.
	hook.init('extensions.register', () => {
		context.registry.provide(auditRef, { list: () => [...entries] });
	});

	hook.filter<NewProduct>('products.create', (draft) => ({ ...draft, name: draft.name.trim() }));

	hook.action('products.created', (meta) => {
		entries.push({ event: String(meta['event']), at: new Date().toISOString(), data: meta['product'] });
	});

	// Every day at 03:00. Use a shared ScheduleLock when the app runs on several replicas.
	hook.schedule('0 3 * * *', async () => {
		const removed = entries.splice(0, Math.max(0, entries.length - MAX_ENTRIES)).length;
		context.logger.info({ removed }, 'audit log trimmed');
	});
});
