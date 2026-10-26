// Endpoint extension, mounted under /reports (its id). Uses host services from the
// context and the audit service from another extension through the registry.
import { defineEndpoint } from '@codihaus/fastify-extensions/types';
import { auditRef, type AppContext } from '../../src/contracts.js';

export default defineEndpoint<AppContext>((router, context) => {
	router.get('/summary', async () => {
		const products = context.services.products.list();
		return {
			products: products.length,
			stockValue: products.reduce((sum, product) => sum + product.price, 0),
			// tryConsume: the report still works when the audit extension is disabled.
			auditEntries: context.registry.tryConsume(auditRef)?.list().length ?? null,
		};
	});
});
