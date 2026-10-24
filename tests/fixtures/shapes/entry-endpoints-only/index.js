// Bundle with no `hooks`/`endpoints`/default export — only an `endpoint_<name>` export
// for its declared entry. Mounted under `/only`.
export function endpoint_only(router) {
	router.get('/ping', async () => ({ scope: 'only' }));
}
