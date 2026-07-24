// Bundle: named `hooks` + `endpoints` + `endpoint_extra` exports.
// - hooks           -> registered in Phase 1
// - endpoints       -> mounted under `/billing` (first endpoint entry name)
// - endpoint_extra  -> mounted under `/extra`
export function hooks(hook, context) {
	if (context && Array.isArray(context.marks)) {
		context.marks.push('bundle-full:hooks');
	}
	hook.filter('audit.event', (payload) => {
		return { ...payload, audited: true };
	});
}

export function endpoints(router) {
	router.get('/status', async () => {
		return { scope: 'billing' };
	});
}

export function endpoint_extra(router) {
	router.get('/info', async () => {
		return { scope: 'extra' };
	});
}
