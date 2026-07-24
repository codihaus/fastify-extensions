import type { FastifyInstance } from 'fastify';
import { describe, expectTypeOf, it } from 'vitest';
import {
	createServiceRef,
	defineEndpoint,
	defineHook,
	type ServiceRegistry,
} from '../src/types.js';

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
