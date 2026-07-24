// Manifest fails validation (`type` is neither "hook" nor "endpoint"), so discovery
// must skip this package entirely — the filter below should never register.
export default function invalidManifest(hook) {
	hook.filter('invalid.event', (payload) => {
		return { ...payload, loaded: true };
	});
}
