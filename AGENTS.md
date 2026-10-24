# @codihaus/fastify-extensions — Agent Guide

Use this guide when integrating or authoring extensions for `@codihaus/fastify-extensions`.

## Install

```bash
npm install @codihaus/fastify-extensions
```

`fastify` is an optional peer dependency — only required if you mount endpoint extensions or use the plugin wrapper. `cron` is the only runtime dependency (bundled).

## Core Concepts

1. **`ExtensionManager<TContext>`** — discovers, loads, and tracks extensions. Generic over the host-defined context injected into every extension.
2. **Extension** — an npm-package-shaped folder (has `package.json`) whose package.json carries a `manifestKey` entry. Lives in a local `extensionsPath` directory or as an npm `dependency` of the host.
3. **Two-phase loading** — hooks register in Phase 1 (no Fastify instance needed); endpoints mount in Phase 2 (after the Fastify instance exists).
4. **`Emitter<TEventContext>`** — three-tier event bus (filter/action/init) plus cron scheduling. Owned by the manager by default, or injected to share across host + extensions.
5. **`ServiceRegistry`** — cross-extension service sharing (`provide`/`consume`), sealed right after the `extensions.register` init event.
6. **`./types` subpath** — the zero-runtime surface for extension AUTHORS (`defineHook`, `defineEndpoint`, `createServiceRef`, plus all type names). Never import the manager/loader from here.

## Source Layout

```
src/
├── index.ts          public barrel (package root export)
├── types.ts          authoring surface, published as ./types — runtime-free
├── kernel/           extension microkernel (no Fastify runtime import)
│   ├── manager.ts    ExtensionManager: lifecycle phases, mustLoad, cleanup
│   ├── discovery.ts  local + npm-dependency scan, manifest validation
│   ├── loader.ts     import, shape classification, hook/endpoint registration
│   └── registry.ts   cross-extension service registry
├── runtime/          shared by kernel and kit
│   ├── emitter.ts    filter / action / init tiers + schedules
│   ├── schedule.ts   cron jobs + ScheduleLock
│   └── logger.ts     console fallback logger
├── plugin/
│   └── fastify-extensions.ts   one-phase Fastify plugin
└── kit/              app kit (ServerExtension)
    ├── server-extension.ts     boot order, listen, close, signals
    ├── options.ts              AppKitOptions + context/plugin types
    ├── http-defaults.ts        Fastify defaults, request id, empty JSON, error/404
    ├── health.ts               live/ready probes
    ├── shutdown.ts             phased shutdown hooks with timeout
    └── view.ts                 @fastify/view + liquid / pug / twig
```

Dependency direction: `kit` and `plugin` → `kernel` → `runtime` → `types`. Nothing imports `kit` except `index.ts`.

## Boot Order

```
manager = new ExtensionManager({ manifestKey, extensionsPath, createContext, ... })
await manager.scanAndLoadHooks()        // Phase 1: scan -> import -> register hooks -> mustLoad check
                                         // (host may emit its own early events on manager.emitter here)
app = fastify()                         // host builds the Fastify instance, mounts its own routes
await manager.registerServices()        // OPTIONAL Phase 1.5: emitInit('extensions.register') -> registry.seal()
                                         // (call it when host init events emitted before Phase 2 must see sealed services)
await manager.loadEndpoints(app)        // Phase 2: mount endpoints -> onManifest -> [emitInit('extensions.register') -> registry.seal(),
                                         //   only if registerServices() did not run]
app.listen()
```

## App Kit (`ServerExtension`)

One-call boot for hosts that want the full stack. Import from the package root.

```ts
import { ServerExtension } from '@codihaus/fastify-extensions';

const kit = await ServerExtension.start({            // create() = same, without listen/signals
	name: 'orders',
	port: 3000, host: '0.0.0.0',                       // defaults 3000 / 127.0.0.1
	extensions: { manifestKey: 'orders-extension', extensionsPath: './extensions' },  // omit = no extensions
	context: (base) => ({ ...base, db }),             // default: AppKitBaseContext
	services: (registry, kit) => {},                   // host provide() before extensions.register
	plugins: [[import('@fastify/cors'), { origin: true }]],
	middlewares: (app, kit) => {},
	routes: (app, kit) => {},
	onReady: (kit) => {},
	onClose: (kit) => {},                              // shutdown phase "connections"
	health: { path: '/health', checks: { db: () => db.ping() }, timeoutMs: 3000 },
	view: { engine: 'liquid', root: './views' },      // default liquid; 'pug' | 'twig' need the host to install them; false = off
	fastify: { /* FastifyServerOptions, override kit defaults */ },
});
```

Kit boot order (mirrors ODP core `service/api`):

```
Fastify(...) + onRequest health/request-id + error/404 handlers
manager.scanAndLoadHooks()                      // Phase 1
options.services -> manager.registerServices()  // registry sealed BEFORE any kit init event
register @fastify/view (unless view: false)     // reply.view available to host routes AND extension endpoints
init app.before -> plugins -> init middlewares.before -> options.middlewares -> init middlewares.after
init routes.before -> options.routes -> manager.loadEndpoints(app) -> init routes.after
init app.after -> app.ready() -> options.onReady
start(): listen -> action server.start { address, port, host }; SIGINT/SIGTERM -> close
close(): action server.stop { reason } -> app.close() -> shutdown hooks: workers -> schedules (manager.reset) -> connections (onClose)
```

Kit rules:

- Init event meta is `{ app }`. Kit actions (`server.start`, `server.stop`) pass `undefined` as event context.
- The kit owns its emitter. `close()` (or `app.close()`) stops every extension schedule.
- `close()` is idempotent. `listen()` runs once, only in state `ready`.
- A boot failure closes the app, runs the shutdown hooks, and rethrows.
- Extensions register their own shutdown work with `context.onShutdown(phase, name, run)` (name is prefixed with the extension id).
- Hooks of one shutdown phase run in parallel. A hook that throws or exceeds `shutdownTimeoutMs` (default 10000) is logged and skipped.
- The kit reads no environment variables. Pass `port`/`host` explicitly. (Exception: view template caching defaults to `NODE_ENV === 'production'`, the `@fastify/view` default; set `view.production` to override.)
- View output is HTML-escaped on every engine (Liquid `outputEscape: 'escape'`, Twig `autoescape`, Pug `#{}`). Do not turn escaping off for user data; use `| raw` / `!{}` only for trusted HTML. Twig: `@fastify/view` merges `view.options` into render data, so never pass a `settings` key in view data (it would replace the autoescape setting).
- `liquidjs` and `@fastify/view` are dependencies; `pug` and `twig` are optional peers loaded lazily. A missing engine fails boot with the `npm install` command in the message.
- `process.exit` is called only by the signal handler of `start()`, and only when `exitOnSignal` is not `false`. A second signal during shutdown exits with code 1.

Single-phase convenience (no pre-server hooks needed):

```ts
import { fastifyExtensions } from '@codihaus/fastify-extensions';

let manager;
await app.register(fastifyExtensions, {
	manifestKey: 'myapp-extension',
	extensionsPath: './extensions',
	createContext: (config) => ({ log: app.log.child({ extension: config.id }) }),
	onManager: (created) => { manager = created; },
});
// app.addHook('onClose', ...) -> manager.reset() is wired automatically
```

The plugin is NOT wrapped with `fastify-plugin` — `app.register()` runs it in an encapsulated child scope: extension routes are confined to that scope, and the `extensions` decorator is set on the child scope, so the OUTER `app.extensions` is `undefined`. Get the manager via the `onManager` option (above), or call the plugin function directly — `await fastifyExtensions(app, options)` — to mount at the root and decorate the exact instance you hold (`app.extensions` then works).

If Phase 1 or Phase 2 throws (e.g. a missing `mustLoad` id), the plugin calls `manager.reset()` before rethrowing, so no hook or cron job outlives the failed boot. A second direct call on an instance that already has `extensions` keeps the first decorator, logs a warning, and hands the new manager out through `onManager` only.

## `ExtensionManagerOptions<TContext>`

```ts
interface ExtensionManagerOptions<TContext> {
	manifestKey: string;                        // REQUIRED — key in extension package.json, e.g. "myapp-extension"
	extensionsPath?: string;                     // omit to skip local dir scan
	moduleRoot?: string | false;                 // default: process.cwd(); false disables npm-dep scan
	mustLoad?: string[];                         // default: [] — missing id here -> scanAndLoadHooks() throws
	logger?: ExtensionLoggerLike;                // default: console-backed (see below)
	emitter?: Emitter<any>;                      // default: manager creates and owns its own Emitter
	isEnabled?: (id: string) => Promise<boolean> | boolean;  // default: () => true
	onManifest?: (pkg: Record<string, unknown>, config: ExtensionConfig) => void | Promise<void>;
	createContext: (config: ExtensionConfig) => TContext;    // REQUIRED — called ONCE per extension
	scheduleLock?: ScheduleLock;                 // default: MemoryScheduleLock (single-instance)
}
```

`ExtensionManager` methods:

```ts
class ExtensionManager<TContext> {
	constructor(options: ExtensionManagerOptions<TContext>);
	scanAndLoadHooks(): Promise<void>;                 // Phase 1
	loadEndpoints(app: FastifyInstance): Promise<void>; // Phase 2
	scanExtensions(): Promise<ExtensionConfig[]>;       // discovery only, no loading
	getExtensions(): ExtensionConfig[];                 // loaded only
	getExtension(id: string): LoadedExtension | undefined;
	unloadExtension(id: string): Promise<boolean>;      // runs cleanups; cannot un-mount Fastify routes
	reset(): Promise<void>;                             // all cleanups + registry reset + stop schedules (if owned emitter)
	get emitter(): Emitter<unknown>;
	get registry(): ServiceRegistry;
}
```

## Extension Module Shapes

Given the resolved entry module (a namespace record):

1. **Bundle** — named exports `hooks(hook, context)` and/or `endpoints(router, context)`, or at least one `endpoint_X` export matching a declared endpoint entry.
   - `hooks` registers in Phase 1.
   - `endpoints` mounts in Phase 2 under `/<first manifest endpoint entry name, else the extension id>`.
   - Each manifest entry `{ type: "endpoint", name: X }` additionally looks for a named export `endpoint_X` and mounts it under `/X`.
2. **Single default export** — `export default function`:
   - `manifest.type === "endpoint"` (and `manifest.bundle` is `null`) → endpoint extension, mounted in Phase 2 under `/<id>`.
   - otherwise → hook extension, registered in Phase 1.
3. **Anything else** → logged as `unrecognized extension shape` and skipped (never throws).

Entry-point resolution (relative to the extension root), first match wins: manifest `path` → package.json `main` → `dist/index.js`. Imported via dynamic `import()` of a `pathToFileURL(...)`-built URL (Windows-safe).

## Manifest Schema

Parsed from `pkg[manifestKey]`, validated by hand (`validateManifest`, zero deps):

```jsonc
{
	"id": "my-extension",           // optional, defaults to folder name (local) or package name (module)
	"type": "hook" | "endpoint",     // optional, only meaningful for single-default-export modules
	"path": "dist/custom.js",        // optional entry override
	"bundle": null,                  // optional; non-null string marks a default-export bundle as hook (ODP parity)
	"entries": [                     // optional bundle entries
		{ "type": "hook", "name": "audit" },
		{ "type": "endpoint", "name": "billing" }
	]
	// extra fields are allowed, preserved, and forwarded untouched to onManifest
}
```

Invalid manifest (fails `validateManifest`) → warn + extension excluded from that scan. Missing `manifestKey` entirely → not discovered at all.

## Discovery Rules

- **Local scan** (`scanLocalExtensions`) — each subdirectory of `extensionsPath` with a readable `package.json` containing `manifestKey` is a candidate. Unreadable dir → empty result (debug log). Invalid JSON → warn, skip that entry.
- **Module scan** (`scanModuleExtensions`) — reads `dependencies` (never `devDependencies`) of the package.json at `moduleRoot`, resolves each via `createRequire(...).resolve('<name>/package.json', { paths: [moduleRoot] })`, falling back to the node_modules lookup paths from `moduleRoot` when the package's `exports` map hides `./package.json`. Unresolvable → skipped with a debug log.
- **Precedence** — local wins over module on id collision; module configs whose id already exists locally are dropped from `scanExtensions()`'s result.
- **`isEnabled(id)`** is consulted in `scanAndLoadHooks()` (Phase 1) only — a disabled extension still shows up in `scanExtensions()` but is never loaded. `isEnabled` throwing is treated as fail-open (`enabled = true`, warn logged).

## Error Isolation

- One extension failing to import/register (either phase) → `logger.error({ id, error }, ...)`, loop continues. Exception: ids in `mustLoad` make `scanAndLoadHooks()` throw if missing from the pending set after the scan.
- A hook registration that throws partway through unwinds its own partial cleanup fns before rethrowing — no half-registered leftovers.
- `onManifest` throwing → warn, extension still loads (non-fatal). `isEnabled` throwing → warn, treated as enabled.

## Emitter Tiers

```ts
class Emitter<TEventContext = unknown> {
	constructor(options?: { logger?: ExtensionLoggerLike; scheduleLock?: ScheduleLock });

	onFilter<T>(event: string, handler: FilterHandler<T, TEventContext>): void;
	offFilter<T>(event: string, handler: FilterHandler<T, TEventContext>): void;
	onAction(event: string, handler: ActionHandler<TEventContext>): void;
	offAction(event: string, handler: ActionHandler<TEventContext>): void;
	onInit(event: string, handler: InitHandler): void;
	offInit(event: string, handler: InitHandler): void;

	emitFilter<T>(event: string | string[], payload: T, meta: Record<string, unknown>, context: TEventContext): Promise<T>;
	emitAction(event: string | string[], meta: Record<string, unknown>, context: TEventContext): void;
	emitInit(event: string, meta?: Record<string, unknown>): Promise<void>;

	addSchedule(name: string, cron: string, handler: () => Promise<void>): () => Promise<void>;
	stopAllSchedules(): Promise<void>;
	reset(): Promise<void>;
}
```

| Tier | Order | Await | Error behavior |
|---|---|---|---|
| filter | sequential, each handler receives the previous handler's output | awaited | thrown error propagates out of `emitFilter`, stops the pipeline |
| action | parallel, fire-and-forget | not awaited | caught per-handler, logged, never thrown |
| init | sequential | awaited | thrown error propagates out of `emitInit`, stops the loop |

- `event` accepts a single string or `string[]` (processed in array order) for `emitFilter`/`emitAction`; `emitInit` takes one event.
- The `event` key of handler meta is reserved: it always carries the actual emitted event name; caller-provided `meta.event` is ignored.
- Pattern matching on subscribe-side patterns: exact (`items.create`), wildcard-all (`*`), prefix (`items.*` matches `items.create`), suffix (`*.create` matches `items.create` and `articles.items.create`). Wildcards are dot-segment-bounded: `*.create` does NOT match `recreate` or `items.recreate`.
- Action tier: a synchronous throw in a handler is caught and logged too — `emitAction` never throws and remaining handlers still start.
- `addSchedule` validates the cron string with `cron`'s `validateCronExpression` — invalid → warn + no-op unregister function returned (never throws). Valid jobs are namespaced by the caller as `ext:<extension-id>:<cron>` when registered via `HookContext.schedule`; calling `emitter.addSchedule` directly does not add that prefix.
- Each tick computes the next timestamp and calls `scheduleLock.claim(name, timestamp)` — only the instance that wins runs the handler. Handler and lock errors are logged, never thrown.

## Registry + Service Refs

```ts
function createServiceRef<T>(id: string): ServiceRef<T>;

interface ServiceRegistry {
	provide<T>(ref: ServiceRef<T>, impl: T): void;
	consume<T>(ref: ServiceRef<T>): T;                      // throws if absent
	tryConsume<T>(ref: ServiceRef<T> | string): T | undefined; // soft — accepts a ref or a plain id
	has(id: string): boolean;
}
```

- Providers call `provide` during the `extensions.register` init event (emitted inside `loadEndpoints`, right before `registry.seal()`).
- `consume` after seal: returns the impl or throws `No provider for service "<id>" ...`. `consume` before seal: throws a different message telling the caller to move the call to a post-seal point.
- `tryConsume` before seal degrades to `undefined` and logs once per id (self-diagnosing misuse — surfaces on first dev boot). After seal, a missing id logs at debug and returns `undefined`.
- `manager.registry` is one instance per manager, auto-sealed at the end of `loadEndpoints`. Never call `seal()`/`reset()` yourself from host code — those are manager-internal.

## ScheduleLock

```ts
interface ScheduleLock {
	claim(name: string, timestamp: number): Promise<boolean>; // true = this instance runs the tick
	release(name: string): Promise<void>;                     // called when the schedule stops
}
```

Default `MemoryScheduleLock` always claims (correct for a single instance). Back it with Redis/DB for multi-instance deployments so only one instance runs a given cron tick. Passed via `ExtensionManagerOptions.scheduleLock` — only takes effect when the manager owns the emitter (i.e. `emitter` option was not injected). Passing both `emitter` and `scheduleLock` logs a warning; give the lock to the injected `Emitter` instead.

## Logger

```ts
interface ExtensionLoggerLike {
	debug(obj: unknown, msg?: string): void;
	info(obj: unknown, msg?: string): void;
	warn(obj: unknown, msg?: string): void;
	error(obj: unknown, msg?: string): void;
	child(bindings: Record<string, unknown>): ExtensionLoggerLike;
}
```

Structurally compatible with pino — pass `app.log` or a pino instance directly, zero glue. Default: `createConsoleLogger()`, a thin console wrapper honoring the same `(obj, msg?)` signature.

## The `./types` Subpath (for extension authors)

Extension packages should depend only on `@codihaus/fastify-extensions/types` — never the root entry (that pulls in the manager/loader/Node-only code).

```ts
import { defineHook, defineEndpoint, createServiceRef } from '@codihaus/fastify-extensions/types';
import type { HookContext, EndpointConfig, ServiceRef } from '@codihaus/fastify-extensions/types';

// hook extension
export default defineHook<MyContext, MyEventContext>((hook, context) => {
	hook.filter('items.create', async (payload, meta, eventContext) => ({ ...payload, touched: true }));
	hook.action('items.create', async (meta, eventContext) => { /* side effect */ });
	hook.init('extensions.register', async (meta) => { /* provide services here */ });
	hook.schedule('*/5 * * * *', async () => { /* cron job */ });
});

// endpoint extension (manifest.type must be "endpoint")
export default defineEndpoint<MyContext>((router, context) => {
	router.get('/ping', async () => ({ ok: true, id: context.id }));
});
```

A host typically re-publishes these symbols from its own types package pre-bound to its concrete `TContext` (mirrors ODP's `@odp/api/types` pattern), so extension authors never import the loader-carrying root entry.

`defineHook`/`defineEndpoint` are identity functions — they exist only to give an inline arrow function its generics without a cast.

## Limitations (documented, not bugs)

- No endpoint route unregistration — Fastify cannot un-mount a route once registered. `unloadExtension`/`reset` only undo hook/action/init/schedule registrations (`LoadedExtension.cleanupFns`).
- No ESM module cache eviction — `unloadExtension` does not (cannot) un-import the module; re-loading the same id creates a second in-memory instance of its closures.
- No hot-reload file watcher — out of scope for v1; the cleanup-fn design exists to support it later.
- No runtime npm install — extensions must already be on disk (`extensionsPath` folder or resolvable `node_modules` dependency).
- Extensions are trusted code — no vm/worker sandboxing.
- `manifestKey` has no default — every host must pick its own key to avoid ecosystem collisions.
- One-shot lifecycle — `scanAndLoadHooks()`, `registerServices()` and `loadEndpoints()` each run once per cycle (`idle -> hooks-loaded -> ready`); calling either again throws until `reset()` returns the manager to `idle`. An `extensions.register` init failure propagates but still seals the registry (terminal cycle).
- Load results are truthful — unrecognized module shapes and extensions whose endpoint setup throws are skipped/discarded, never reported by `getExtensions()`. Routes mounted before an endpoint setup threw remain reachable (partial mount).
- Duplicate ids — within one source the alphabetically/declaration-first candidate wins and the duplicate is logged as an error; across sources, local wins over module.

## Rules for Agents

1. `createContext` is called exactly ONCE per extension id and the same instance flows to both the hook phase and the endpoint phase — do not rebuild context per phase.
2. `manager.emitter` and `manager.registry` are getters — treat them as read-only handles, never reassign.
3. `extensions.register` fires (via `emitInit`) and the registry seals inside `registerServices()` when the host calls it (the kit always does), otherwise INSIDE `loadEndpoints` after endpoints mount — cross-extension `provide` must happen in an `init` handler subscribed to that exact event name.
4. `hook.schedule(cron, handler)` auto-namespaces the job as `ext:<id>:<cron>`; do not add your own prefix. A repeated cron in the same extension gets `#2`, `#3`, ... so a shared `ScheduleLock` sees separate jobs.
5. Bundle endpoint prefix rule: `endpoints` export mounts under the FIRST `entries` item with `type: "endpoint"` (falls back to the extension id if none declared); every other declared endpoint entry `X` needs its own `endpoint_X` export to mount under `/X`.
6. A default-export module is only treated as an endpoint when `manifest.type === "endpoint"` AND `manifest.bundle` is `null`/absent — a non-null `bundle` string forces hook classification even with a default export.
7. Module (npm-dependency) discovery only scans `dependencies`, never `devDependencies` — do not expect a dev-only extension package to be picked up.
8. `isEnabled` returning `false` still leaves the extension visible in `scanExtensions()` — "discovered" and "loaded" are different sets (`getExtensions()` returns loaded only).
9. Import extension-author code only from `@codihaus/fastify-extensions/types`; import the manager/emitter/registry/plugin from the root `@codihaus/fastify-extensions`.
10. `reset()` stops schedules only if the manager OWNS the emitter (i.e. no `emitter` option was injected) — an injected/shared emitter's schedules outlive that manager's `reset()`.

