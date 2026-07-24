// Async hook setup: the filter registers only AFTER an await. The loader must await
// the setup function so this registration is visible before Phase 1 completes.
export default async function asyncHook(hook) {
	await new Promise((resolveTick) => setTimeout(resolveTick, 10));
	hook.filter('async.event', (payload) => ({ ...payload, asyncRegistered: true }));
}
