// First (alphabetically) of two local fixtures declaring the same manifest id
// "dup-ext". Deterministic duplicate handling must keep THIS one.
export default function duplicateFirst(hook) {
	hook.filter('dup.event', (payload) => ({ ...payload, winner: 'aaa-first' }));
}
