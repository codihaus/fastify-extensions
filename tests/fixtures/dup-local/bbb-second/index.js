// Second local fixture with the duplicate id "dup-ext" — must be ignored with an
// error log; if it ever loads, the filter would mark the payload with its name.
export default function duplicateSecond(hook) {
	hook.filter('dup.event', (payload) => ({ ...payload, winner: 'bbb-second' }));
}
