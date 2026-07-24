// CASE STUDY 3 — Bundle extension.
// One package, multiple named exports:
//   hooks          -> registered in Phase 1
//   endpoints      -> mounted under `/audit`  (the FIRST endpoint entry name)
//   endpoint_health-> mounted under `/health` (matches the `health` entry)
// The manifest `entries` array is what drives the endpoint prefixes.

export function hooks(hook, context) {
	// Wildcard action subscription: audit EVERY action event that flows through the emitter.
	hook.action('*', (meta) => {
		context.db.audit.push({ event: meta.event, at: context.now() });
	});
}

export function endpoints(router, context) {
	// GET /audit/log
	router.get('/log', async () => {
		return context.db.audit;
	});
}

export function endpoint_health(router) {
	// GET /health
	router.get('/', async () => {
		return { status: 'ok' };
	});
}
