// Default export, manifest without `type` -> treated as a hook extension.
// Registers one filter (transforms payload) and one action (records into the
// event context supplied at emit time). Writes a marker into the injected
// context to prove createContext() reached the extension.
export default function hookBasic(hook, context) {
	if (context && Array.isArray(context.marks)) {
		context.marks.push('hook-basic:init');
	}

	hook.filter('items.create', (payload) => {
		return { ...payload, hooked: true };
	});

	hook.action('items.create', (meta, eventContext) => {
		if (eventContext && Array.isArray(eventContext.actions)) {
			eventContext.actions.push('items.create');
		}
	});
}
