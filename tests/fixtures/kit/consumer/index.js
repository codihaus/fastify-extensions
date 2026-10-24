// Bundle: hooks trace every kit init event and consume `greeter` inside `app.before`
// (legal only because the kit seals the registry first); endpoints consume it at
// setup time and per request.
const greeterRef = { id: 'greeter' };
const KIT_EVENTS = ['app.before', 'middlewares.before', 'middlewares.after', 'routes.before', 'routes.after', 'app.after'];

export function hooks(hook, context) {
	for (const event of KIT_EVENTS) {
		hook.init(event, (meta) => {
			context.trace.push(`consumer:${event}`);
			if (event === 'app.before') {
				context.greetedAtAppBefore = context.registry.consume(greeterRef).greet('app.before');
				context.appSeen = meta.app !== undefined;
			}
		});
	}
	hook.action('server.start', (meta) => {
		context.trace.push(`consumer:server.start:${meta.address}`);
	});
	hook.action('server.stop', (meta) => {
		context.trace.push(`consumer:server.stop:${meta.reason}`);
	});
	hook.schedule('0 0 1 1 *', async () => {});
	context.onShutdown('workers', 'queue', () => {
		context.trace.push('consumer:shutdown:workers');
	});
}

export function endpoints(router, context) {
	const greeter = context.registry.consume(greeterRef);
	router.get('/hello', async () => ({ message: greeter.greet('kit') }));
	router.get('/boom', async () => {
		throw new Error('database password leaked here');
	});
	router.get('/bad', async () => {
		const error = new Error('quantity must be positive');
		error.statusCode = 400;
		error.code = 'BAD_QUANTITY';
		throw error;
	});
	router.post('/echo', async (request) => ({ body: request.body ?? null }));
	// reply.view comes from the kit's root-level @fastify/view registration.
	router.get('/page', async (_request, reply) => reply.view('ext', { items: [1, 2], ext: context.extensionId }));
}
