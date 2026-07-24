// Endpoint extension whose setup registers one route and then throws. The manager
// must log the error, discard the extension (not report it loaded), and keep the
// Fastify instance healthy for the remaining extensions.
export default function endpointFail(router) {
	router.get('/before-crash', async () => ({ mounted: 'partially' }));
	throw new Error('endpoint-fail fixture throws during setup');
}
