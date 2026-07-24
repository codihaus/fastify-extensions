import { defineEndpoint } from '@codihaus/fastify-extensions/types';

// Host policy disables this extension. Its manifest is discovered, but this module
// is never imported and this route is never mounted.
export default defineEndpoint((router) => {
	router.get('/status', async () => ({ enabled: true }));
});
