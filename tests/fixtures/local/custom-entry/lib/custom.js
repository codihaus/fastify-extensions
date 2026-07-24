// Reached only via manifest `path` (there is no `main` and no `dist/index.js`),
// so loading it proves the entry-resolution precedence `path > main > dist/index.js`.
export default function customEntry(hook) {
	hook.filter('custom.event', (payload) => {
		return { ...payload, custom: true };
	});
}
