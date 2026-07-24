// Valid extension used with `isEnabled: () => false`. If it were ever loaded, this
// filter would mutate the payload; tests assert it does NOT run.
export default function disabledExtension(hook) {
	hook.filter('disabled.event', (payload) => {
		return { ...payload, shouldNotRun: true };
	});
}
