import type { FastifyInstance, FastifyReply } from 'fastify';
import { describe, expectTypeOf, it } from 'vitest';
import {
	createServiceRef,
	defineEndpoint,
	defineHook,
	type ServiceRegistry,
} from '../src/types.js';
import { ServerExtension, type AppKitBaseContext } from '../src/kit/index.js';

interface MyContext {
	id: string;
	marks: string[];
}

interface MyEventContext {
	actions: string[];
}

interface MyService {
	greet(name: string): string;
}

describe('defineHook', () => {
	it('binds TContext and TEventContext into the callback without a cast', () => {
		defineHook<MyContext, MyEventContext>((hook, context) => {
			expectTypeOf(context).toEqualTypeOf<MyContext>();
			hook.filter('items.create', (payload, meta, eventContext) => {
				expectTypeOf(eventContext).toEqualTypeOf<MyEventContext>();
				return payload;
			});
		});
	});
});

describe('defineEndpoint', () => {
	it('binds TContext into the callback without a cast', () => {
		defineEndpoint<MyContext>((router, context) => {
			expectTypeOf(router).toEqualTypeOf<FastifyInstance>();
			expectTypeOf(context).toEqualTypeOf<MyContext>();
		});
	});
});

describe('createServiceRef + ServiceRegistry', () => {
	it('round-trips the service type through consume without a cast', () => {
		const ref = createServiceRef<MyService>('my-service');
		const registry: ServiceRegistry = {} as ServiceRegistry;
		const consumed = registry.consume(ref);
		expectTypeOf(consumed).toEqualTypeOf<MyService>();
	});
});

describe('ServerExtension', () => {
	it('defaults TContext to AppKitBaseContext', () => {
		const create = () => ServerExtension.create({ name: 'typed' });
		expectTypeOf<Awaited<ReturnType<typeof create>>>().toEqualTypeOf<ServerExtension<AppKitBaseContext>>();
	});

	it('brings the reply.view augmentation along with the kit', () => {
		expectTypeOf<FastifyReply['view']>().toBeFunction();
	});

	it('infers TContext from the context option', () => {
		const create = () =>
			ServerExtension.create({
				context: (base) => ({ id: base.extensionId, db: 1 }),
				routes: (_app, kit) => {
					expectTypeOf(kit).toEqualTypeOf<ServerExtension<{ id: string; db: number }>>();
				},
			});
		expectTypeOf<Awaited<ReturnType<typeof create>>>().toEqualTypeOf<ServerExtension<{ id: string; db: number }>>();
	});
});
