import { afterEach, describe, expect, it } from 'vitest';
import {
	createServiceRef,
	ServerExtension,
	type AppKitBaseContext,
	type AppKitOptions,
	type ScheduleLock,
} from '../src/index.js';

const KIT_FIXTURES = new URL('./fixtures/kit', import.meta.url).pathname;
const VIEW_FIXTURES = new URL('./fixtures/views', import.meta.url).pathname;
const MANIFEST_KEY = 'kit-extension';

interface KitTestContext extends AppKitBaseContext {
	trace: string[];
	greetedAtAppBefore?: string;
	appSeen?: boolean;
}

/** Records every release so a test can prove a cron job was stopped. */
class RecordingLock implements ScheduleLock {
	released: string[] = [];
	async claim(): Promise<boolean> {
		return true;
	}
	async release(name: string): Promise<void> {
		this.released.push(name);
	}
}

const openKits: ServerExtension<any>[] = [];

afterEach(async () => {
	await Promise.all(openKits.splice(0).map((kit) => kit.close()));
});

function kitOptions(trace: string[], overrides: Partial<AppKitOptions<KitTestContext>> = {}): AppKitOptions<KitTestContext> {
	return {
		name: 'kit-test',
		fastify: { logger: false },
		extensions: { manifestKey: MANIFEST_KEY, extensionsPath: KIT_FIXTURES, moduleRoot: false },
		context: (base) => ({ ...base, trace }),
		...overrides,
	};
}

async function createKit(trace: string[], overrides: Partial<AppKitOptions<KitTestContext>> = {}) {
	const kit = await ServerExtension.create(kitOptions(trace, overrides));
	openKits.push(kit);
	return kit;
}

describe('ServerExtension.create — boot order', () => {
	it('runs host steps and init events in the ODP core order, with the registry sealed before app.before', async () => {
		const trace: string[] = [];
		const contexts: KitTestContext[] = [];

		const kit = await createKit(trace, {
			context: (base) => {
				const context: KitTestContext = { ...base, trace };
				contexts.push(context);
				return context;
			},
			services: (registry) => {
				trace.push('host:services');
				registry.provide(createServiceRef<string>('host.value'), 'from-host');
			},
			plugins: [
				async () => {
					trace.push('host:plugin');
				},
			],
			middlewares: () => {
				trace.push('host:middlewares');
			},
			routes: (app) => {
				trace.push('host:routes');
				app.get('/', async () => ({ ok: true }));
			},
			onReady: () => {
				trace.push('host:onReady');
			},
		});

		expect(trace).toEqual([
			'host:services',
			'provider:extensions.register',
			'consumer:app.before',
			'host:plugin',
			'consumer:middlewares.before',
			'host:middlewares',
			'consumer:middlewares.after',
			'consumer:routes.before',
			'host:routes',
			'consumer:routes.after',
			'consumer:app.after',
			'host:onReady',
		]);

		expect(kit.state).toBe('ready');
		expect(kit.manager.registrySealed).toBe(true);
		expect(kit.extensions.map((config) => config.id).sort()).toEqual(['consumer', 'provider']);
		expect(kit.registry.consume(createServiceRef<string>('host.value'))).toBe('from-host');

		// createContext ran exactly once per extension.
		expect(contexts).toHaveLength(2);
		const consumer = contexts.find((context) => context.extensionId === 'consumer');
		expect(consumer?.greetedAtAppBefore).toBe('hello app.before');
		expect(consumer?.appSeen).toBe(true);
		expect(consumer?.appName).toBe('kit-test');
	});

	it('serves extension endpoints that consumed a service at setup time', async () => {
		const kit = await createKit([]);
		const response = await kit.app.inject({ method: 'GET', url: '/consumer/hello' });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ message: 'hello kit' });
	});

	it('registers [plugin, options] pairs, including the import() promise form', async () => {
		const received: unknown[] = [];
		const kit = await createKit([], {
			extensions: undefined,
			plugins: [
				[
					Promise.resolve({
						default: async (_app: unknown, options: Record<string, unknown>) => {
							received.push(options);
						},
					}),
					{ origin: true },
				],
				[
					async (_app: unknown, options: Record<string, unknown>) => {
						received.push(options);
					},
					{ inline: 1 },
				],
			],
		});
		expect(kit.state).toBe('ready');
		expect(received).toEqual([{ origin: true }, { inline: 1 }]);
	});

	it('echoes the id from a custom fastify.genReqId', async () => {
		const kit = await createKit([], { extensions: undefined, fastify: { logger: false, genReqId: () => 'custom-id' } });
		const response = await kit.app.inject({ url: '/health' });
		expect(response.headers['x-request-id']).toBe('custom-id');
	});

	it('runs without extensions when the extensions option is omitted', async () => {
		const kit = await createKit([], {
			extensions: undefined,
			routes: (app) => {
				app.get('/', async () => ({ ok: true }));
			},
		});
		expect(kit.extensions).toEqual([]);
		const response = await kit.app.inject({ method: 'GET', url: '/' });
		expect(response.json()).toEqual({ ok: true });
	});

	it('closes the app and stops started schedules when boot fails', async () => {
		const lock = new RecordingLock();
		await expect(
			ServerExtension.create(
				kitOptions([], {
					extensions: {
						manifestKey: MANIFEST_KEY,
						extensionsPath: KIT_FIXTURES,
						moduleRoot: false,
						mustLoad: ['missing-extension'],
						scheduleLock: lock,
					},
				}),
			),
		).rejects.toThrow('Required extension "missing-extension" failed to load');

		expect(lock.released).toEqual(['ext:consumer:0 0 1 1 *']);
	});
});

describe('ServerExtension — default HTTP behaviour', () => {
	it('answers liveness and readiness probes, and fails readiness when a check fails', async () => {
		let databaseUp = true;
		const kit = await createKit([], {
			health: {
				checks: {
					database: async () => {
						if (!databaseUp) throw new Error('down');
					},
				},
			},
		});

		expect((await kit.app.inject({ url: '/health' })).json()).toEqual({ status: 'ok' });
		expect((await kit.app.inject({ url: '/health/live' })).json()).toEqual({ status: 'ok' });

		const ready = await kit.app.inject({ url: '/health/ready' });
		expect(ready.statusCode).toBe(200);

		databaseUp = false;
		const notReady = await kit.app.inject({ url: '/health/ready' });
		expect(notReady.statusCode).toBe(503);
		expect(notReady.json()).toEqual({ status: 'error' });
	});

	it('fails readiness when a check outlives the timeout', async () => {
		const kit = await createKit([], {
			health: { timeoutMs: 20, checks: { slow: () => new Promise((resolve) => setTimeout(resolve, 200)) } },
		});
		const response = await kit.app.inject({ url: '/health/ready' });
		expect(response.statusCode).toBe(503);
	});

	it('disables probes with health: false', async () => {
		const kit = await createKit([], { health: false });
		expect((await kit.app.inject({ url: '/health' })).statusCode).toBe(404);
	});

	it('echoes a safe x-request-id and replaces an unsafe one', async () => {
		const kit = await createKit([]);

		const safe = await kit.app.inject({ url: '/consumer/hello', headers: { 'x-request-id': 'trace-123' } });
		expect(safe.headers['x-request-id']).toBe('trace-123');

		const unsafe = await kit.app.inject({ url: '/consumer/hello', headers: { 'x-request-id': 'bad id<script>' } });
		expect(unsafe.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('accepts an empty JSON body and still rejects malformed JSON with 400', async () => {
		const kit = await createKit([]);

		const empty = await kit.app.inject({
			method: 'POST',
			url: '/consumer/echo',
			headers: { 'content-type': 'application/json' },
			payload: '',
		});
		expect(empty.statusCode).toBe(200);
		expect(empty.json()).toEqual({ body: null });

		const malformed = await kit.app.inject({
			method: 'POST',
			url: '/consumer/echo',
			headers: { 'content-type': 'application/json' },
			payload: '{oops',
		});
		expect(malformed.statusCode).toBe(400);
	});

	it('hides 5xx messages, keeps 4xx messages, and omits the query string from 404s', async () => {
		const kit = await createKit([]);

		const boom = await kit.app.inject({ url: '/consumer/boom' });
		expect(boom.statusCode).toBe(500);
		expect(boom.json()).toMatchObject({ statusCode: 500, message: 'Internal Server Error' });
		expect(boom.body).not.toContain('password');

		const bad = await kit.app.inject({ url: '/consumer/bad' });
		expect(bad.statusCode).toBe(400);
		expect(bad.json()).toEqual({
			statusCode: 400,
			error: 'Bad Request',
			code: 'BAD_QUANTITY',
			message: 'quantity must be positive',
		});

		const missing = await kit.app.inject({ url: '/nope?token=secret' });
		expect(missing.statusCode).toBe(404);
		expect(missing.json()).toMatchObject({ code: 'ROUTE_NOT_FOUND', message: 'Route GET /nope not found' });
		expect(missing.body).not.toContain('secret');
	});
});

describe('ServerExtension — view engine', () => {
	it('renders Liquid by default, with partials, filters, defaultContext, and from extension endpoints', async () => {
		const kit = await createKit([], {
			view: {
				root: `${VIEW_FIXTURES}/liquid`,
				defaultContext: { site: 'Acme' },
				setup: (liquid) => liquid.registerFilter('shout', (value: string) => value.toUpperCase()),
			},
			routes: (app) => {
				app.get('/', async (_request, reply) => reply.view('home', { name: 'kit' }));
			},
		});

		const home = await kit.app.inject({ url: '/' });
		expect(home.statusCode).toBe(200);
		expect(home.headers['content-type']).toContain('text/html');
		expect(home.body.trim()).toBe('<b>Acme</b><h1>Hello KIT</h1>');

		const extensionPage = await kit.app.inject({ url: '/consumer/page' });
		expect(extensionPage.body).toBe('<p>2 items from consumer</p>');
	});

	it('keeps template syntax inside data as text, not code', async () => {
		const kit = await createKit([], {
			extensions: undefined,
			view: { root: `${VIEW_FIXTURES}/liquid`, setup: (liquid) => liquid.registerFilter('shout', (value: string) => value) },
			routes: (app) => {
				app.get('/', async (_request, reply) => reply.view('home', { name: '{{ 7 | times: 6 }}' }));
			},
		});
		const response = await kit.app.inject({ url: '/' });
		expect(response.body).toContain('{{ 7 | times: 6 }}');
		expect(response.body).not.toContain('42');
	});

	it.each(['liquid', 'pug', 'twig'] as const)('HTML-escapes output by default with %s', async (engine) => {
		const kit = await createKit([], {
			extensions: undefined,
			view: {
				engine,
				root: `${VIEW_FIXTURES}/${engine}`,
				...(engine === 'liquid' ? { setup: (liquid) => liquid.registerFilter('shout', (value: string) => value) } : {}),
			},
			routes: (app) => {
				app.get('/', async (_request, reply) => reply.view('home', { name: '<script>alert(1)</script>' }));
			},
		});
		const response = await kit.app.inject({ url: '/' });
		expect(response.body).toContain('&lt;script&gt;');
		expect(response.body).not.toContain('<script>');
	});

	it.each([
		['pug', '<h1>Hello pug</h1>'],
		['twig', '<h1>Hello twig</h1>'],
	] as const)('renders %s when selected at init', async (engine, expected) => {
		const kit = await createKit([], {
			extensions: undefined,
			view: { engine, root: `${VIEW_FIXTURES}/${engine}` },
			routes: (app) => {
				app.get('/', async (_request, reply) => reply.view('home', { name: engine }));
			},
		});
		const response = await kit.app.inject({ url: '/' });
		expect(response.statusCode).toBe(200);
		expect(response.body.trim()).toBe(expected);
	});

	it('skips the view engine with view: false', async () => {
		const kit = await createKit([], { extensions: undefined, view: false });
		expect(kit.app.hasReplyDecorator('view')).toBe(false);
	});

	it('rejects an unknown engine at boot', async () => {
		await expect(
			ServerExtension.create(kitOptions([], { extensions: undefined, view: { engine: 'ejs' as never } })),
		).rejects.toThrow('Unsupported view engine "ejs"');
	});
});

describe('ServerExtension — shutdown', () => {
	it('emits server.stop, then runs shutdown phases in order, once', async () => {
		const trace: string[] = [];
		const lock = new RecordingLock();
		const kit = await ServerExtension.create(
			kitOptions(trace, {
				extensions: { manifestKey: MANIFEST_KEY, extensionsPath: KIT_FIXTURES, moduleRoot: false, scheduleLock: lock },
				onClose: () => {
					trace.push('host:onClose');
				},
			}),
		);
		kit.onShutdown('schedules', 'host-cron', () => {
			trace.push('host:shutdown:schedules');
		});
		trace.length = 0;

		const first = kit.close('test');
		const second = kit.close('again');
		expect(second).toBe(first);
		await first;

		expect(trace[0]).toBe('consumer:server.stop:test');
		expect(trace.slice(1)).toEqual(['consumer:shutdown:workers', 'host:shutdown:schedules', 'host:onClose']);
		expect(lock.released).toEqual(['ext:consumer:0 0 1 1 *']);
		expect(kit.state).toBe('closed');
		expect(kit.extensions).toEqual([]);
	});

	it('runs the shutdown hooks when the host calls app.close() directly', async () => {
		const trace: string[] = [];
		const kit = await ServerExtension.create(kitOptions(trace, { onClose: () => void trace.push('host:onClose') }));
		await kit.app.close();
		expect(trace).toContain('host:onClose');
		expect(kit.state).toBe('closed');
	});

	it('moves on when a shutdown hook outlives the timeout', async () => {
		const trace: string[] = [];
		const kit = await ServerExtension.create(
			kitOptions(trace, { shutdownTimeoutMs: 20, onClose: () => void trace.push('host:onClose') }),
		);
		kit.onShutdown('workers', 'stuck', () => new Promise(() => {}));
		await kit.close();
		expect(trace).toContain('host:onClose');
	});

	it('rejects an unknown shutdown phase', async () => {
		const kit = await createKit([]);
		expect(() => kit.onShutdown('later' as never, 'x', () => {})).toThrow('Unknown shutdown phase');
	});
});

describe('ServerExtension.start', () => {
	it('listens, emits server.start, serves real HTTP, and refuses a second listen', async () => {
		const trace: string[] = [];
		const kit = await ServerExtension.start(kitOptions(trace, { port: 0, host: '127.0.0.1', signals: false }));
		openKits.push(kit);

		expect(kit.state).toBe('listening');
		expect(kit.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(trace).toContain(`consumer:server.start:${kit.address}`);

		const response = await fetch(`${kit.address}/consumer/hello`);
		expect(await response.json()).toEqual({ message: 'hello kit' });

		await expect(kit.listen()).rejects.toThrow('listen() called in state "listening"');
	});

	it('installs and removes signal handlers', async () => {
		const before = process.listenerCount('SIGTERM');
		const kit = await ServerExtension.start(kitOptions([], { port: 0, exitOnSignal: false }));
		expect(process.listenerCount('SIGTERM')).toBe(before + 1);
		await kit.close();
		expect(process.listenerCount('SIGTERM')).toBe(before);
	});
});
