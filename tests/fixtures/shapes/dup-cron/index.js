// Two schedules on the same cron plus one on another cron.
export default function dupCron(hook) {
	hook.schedule('0 0 1 1 *', async () => {});
	hook.schedule('0 0 1 1 *', async () => {});
	hook.schedule('0 0 2 1 *', async () => {});
}
