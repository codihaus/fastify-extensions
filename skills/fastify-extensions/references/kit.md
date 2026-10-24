# App kit — `ServerExtension`

## Contents
1. API
2. Options
3. Boot order
4. Base context
5. Shutdown
6. Health probes
7. Views
8. Testing
9. Recipes

## 1. API

```ts
import { ServerExtension } from '@codihaus/fastify-extensions';

const kit = await ServerExtension.create(options); // build, no port, no signal handlers
const kit = await ServerExtension.start(options);  // create + listen + SIGINT/SIGTERM handlers

kit.app          // FastifyInstance
kit.manager      // ExtensionManager<TContext>
kit.emitter      // shared Emitter
kit.registry     // ServiceRegistry
kit.logger       // app.log (pino)
kit.extensions   // loaded ExtensionConfig[]
kit.state        // 'building' | 'ready' | 'listening' | 'closing' | 'closed'
kit.address      // after listen
await kit.listen({ port, host })        // once, only in state 'ready'
kit.onShutdown(phase, name, fn)         // returns unregister fn
await kit.close(reason?)                // idempotent
```

`TContext` is inferred from the `context` option; without it, extensions get
`AppKitBaseContext`.

## 2. Options

All optional.

| Option | Type / default | Notes |
|---|---|---|
| `name` | `'app'` | logs, `base.appName`, fallback manifest key `<name>-extension` |
| `fastify` | `FastifyServerOptions` | merged over kit defaults (logger, genReqId) |
| `extensions` | `false` (none) | `{ manifestKey, extensionsPath?, moduleRoot?, mustLoad?, isEnabled?, onManifest?, scheduleLock? }` |
| `context` | `(base) => TContext` | once per extension id |
| `services` | `(registry, kit) => void` | host `provide()` before `extensions.register` |
| `plugins` | `AppKitPlugin[]` | `plugin`, `import('pkg')`, or `[plugin, options]` |
| `middlewares` | `(app, kit) => void` | global hooks: auth, rate limit |
| `routes` | `(app, kit) => void` | host routes, before extension endpoints |
| `onReady` | `(kit) => void` | after `app.ready()`, before listen |
| `onClose` | `(kit) => void` | shutdown phase `connections` |
| `health` | `true` | `false` or `{ path, checks, timeoutMs }` |
| `view` | Liquid on | `false` or `{ engine, root, extension, production, defaultContext, options, setup, propertyName, plugin }` |
| `requestId` | `true` | |
| `acceptEmptyJson` | `true` | |
| `errorHandler` | kit handler | `false` keeps Fastify's, or pass a function |
| `notFoundHandler` | kit handler | `false` keeps Fastify's, or pass a function |
| `shutdownTimeoutMs` | `10000` | per shutdown hook |
| `port`, `host`, `listen` | `3000`, `'127.0.0.1'` | `start()` only |
| `signals` | `['SIGINT','SIGTERM']` | `start()` only; `false` disables |
| `exitOnSignal` | `true` | `start()` only; second signal exits with code 1 |

`moduleRoot` defaults to `false` in the kit when `extensions` is omitted. When `extensions`
is passed, `moduleRoot` follows the manager default (`process.cwd()`): the host's
`dependencies` are scanned for packages carrying the manifest key. Set `moduleRoot: false`
to scan only `extensionsPath`.

The kit reads no environment variables except `NODE_ENV` for view caching. Map env to
options in the host (`port: Number(process.env.PORT ?? 3000)`).

## 3. Boot order

```
Fastify(defaults + options.fastify)
  + onRequest: request-id echo, health probe; error + 404 handlers
manager.scanAndLoadHooks()                 Phase 1: extension hooks registered
options.services(registry)                  host provides
init 'extensions.register'                  extension providers; registry SEALS here
register @fastify/view                      unless view: false
init 'app.before'        { app }
options.plugins
init 'middlewares.before'
options.middlewares
init 'middlewares.after'
init 'routes.before'
options.routes
extension endpoints                         Phase 2
init 'routes.after'
init 'app.after'
app.ready() → options.onReady
start(): listen → action 'server.start' { address, port, host }
```

Because the registry seals before `app.before`, an extension may `consume()` inside any of
these init events and inside endpoint setup functions.

A boot failure (thrown init handler, missing `mustLoad`, plugin error) closes the app, runs
the shutdown hooks (stopping cron jobs), and rethrows.

## 4. Base context

```ts
interface AppKitBaseContext {
  extensionId: string;
  appName: string;
  config: ExtensionConfig;               // id, folder, source, resolvedPath, entries...
  logger: ExtensionLoggerLike;           // child logger { module: 'extensions', extension: id }
  emitter: Emitter<unknown>;
  registry: ServiceRegistry;
  onShutdown(phase, name, run): () => void;   // name prefixed with extension id
}
```

Typed host context:

```ts
export interface AppContext extends AppKitBaseContext { db: Db; now(): string }

ServerExtension.start({
  context: (base): AppContext => ({ ...base, db, now: () => new Date().toISOString() }),
});
```

Put `AppContext` and service refs in a contract module that extensions import.

## 5. Shutdown

Triggered by `kit.close()`, a signal, or `kit.app.close()`:

1. action `server.stop` `{ reason }`
2. Fastify stops accepting, drains in-flight requests, runs its `onClose` hooks
3. shutdown hooks by phase, each phase in parallel, each hook bounded by `shutdownTimeoutMs`:
   - `workers` — queue consumers finish the job in hand
   - `schedules` — extension cleanup + cron stop (built in), host cron
   - `connections` — `onClose`, Redis/DB clients

```ts
kit.onShutdown('workers', 'email-queue', () => queue.close());
// inside an extension:
context.onShutdown('connections', 'redis', () => redis.quit());
```

## 6. Health probes

```ts
health: {
  path: '/health',                       // default
  timeoutMs: 3000,                       // per check
  checks: {
    db: () => db.raw('select 1'),
    redis: () => redis.ping(),
  },
}
```

- `/health`, `/health/live`: always `{ status: 'ok' }` while the process serves HTTP.
- `/health/ready`: 200 when every check resolves in time and the kit is `ready`/`listening`;
  503 otherwise. The failing check name goes to the log, not the response.
- Probes run at `onRequest` before host auth hooks, so orchestrators need no token.

## 7. Views

```ts
view: {
  engine: 'liquid',                      // default; 'pug' | 'twig' need `npm install pug|twig`
  root: join(here, 'views'),             // default <cwd>/views
  defaultContext: { site: 'Acme' },
  setup: (liquid) => liquid.registerFilter('money', (v: number) => v.toFixed(2)),  // Liquid only
}

app.get('/', (request, reply) => reply.view('home', { user }));   // renders views/home.liquid
```

- `reply.view` works in host routes and in extension endpoints (registered at the root).
- Output is HTML-escaped on all engines. Trusted HTML: `{{ html | raw }}` (Liquid, Twig),
  `!{html}` (Pug).
- Liquid is the default because templates cannot run arbitrary JS — safe for templates edited
  by non-developers or stored in a database.
- Twig: never pass a `settings` key in view data; `@fastify/view` merges options into data
  and it would replace the autoescape setting.
- Extensions share the host's view root. Namespace extension templates by folder
  (`views/<extension-id>/page.liquid`, `reply.view('<extension-id>/page')`).
- `production` (cache) defaults to `NODE_ENV === 'production'`.

## 8. Testing

```ts
const kit = await ServerExtension.create({ ...appOptions(), fastify: { logger: false } });
try {
  const res = await kit.app.inject({ method: 'GET', url: '/orders/list' });
  // assertions
} finally {
  await kit.close();       // stops cron jobs; otherwise the runner may hang
}
```

- Use a fresh in-memory resource per test (`appOptions(createDb())`).
- Actions are fire-and-forget: `await setImmediate()` (from `node:timers/promises`) before
  asserting on their effects.
- `start({ port: 0, signals: false })` for a real-port test; read `kit.address`.

## 9. Recipes

**CORS + helmet + cookie**

```ts
plugins: [
  [import('@fastify/cors'), { origin: ['https://app.example.com'], credentials: true }],
  import('@fastify/helmet'),
  import('@fastify/cookie'),
],
```

**Auth middleware that extensions can rely on**

```ts
middlewares: (app) => {
  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => { request.user = await authenticate(request); });
},
```

**Host service for extensions**

```ts
services: (registry) => registry.provide(mailerRef, createMailer()),
```

**Multi-replica cron**

```ts
extensions: { manifestKey: 'orders-extension', extensionsPath: './extensions', scheduleLock: redisLock },
// redisLock.claim(name, ts) → SET key NX PX; release(name) → DEL
```

**No extensions, just the kit**

```ts
await ServerExtension.start({ port: 3000, routes: (app) => { /* ... */ } });
```
