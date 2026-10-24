// Hook extension: provides the `greeter` service during `extensions.register`.
const greeterRef = { id: 'greeter' };

export default function provider(hook, context) {
	hook.init('extensions.register', () => {
		context.trace.push('provider:extensions.register');
		context.registry.provide(greeterRef, { greet: (name) => `hello ${name}` });
	});
}
