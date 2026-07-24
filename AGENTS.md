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

## Boot Order

```
manager = new ExtensionManager({ manifestKey, extensionsPath, createContext, ... })
await manager.scanAndLoadHooks()        // Phase 1: scan -> import -> register hooks -> mustLoad check
                                         // (host may emit its own early events on manager.emitter here)
app = fastify()                         // host builds the Fastify instance, mounts its own routes
await manager.loadEndpoints(app)        // Phase 2: mount endpoints -> onManifest -> emitInit('extensions.register') -> registry.seal()
app.listen()
```

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

1. **Bundle** — named exports `hooks(hook, context)` and/or `endpoints(router, context)`.
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
- **Module scan** (`scanModuleExtensions`) — reads `dependencies` (never `devDependencies`) of the package.json at `moduleRoot`, resolves each via `createRequire(...).resolve('<name>/package.json', { paths: [moduleRoot] })`. Unresolvable → silently skipped.
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

Default `MemoryScheduleLock` always claims (correct for a single instance). Back it with Redis/DB for multi-instance deployments so only one instance runs a given cron tick. Passed via `ExtensionManagerOptions.scheduleLock` — only takes effect when the manager owns the emitter (i.e. `emitter` option was not injected).

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
- One-shot lifecycle — `scanAndLoadHooks()` and `loadEndpoints()` each run once per cycle (`idle -> hooks-loaded -> ready`); calling either again throws until `reset()` returns the manager to `idle`. An `extensions.register` init failure propagates but still seals the registry (terminal cycle).
- Load results are truthful — unrecognized module shapes and extensions whose endpoint setup throws are skipped/discarded, never reported by `getExtensions()`. Routes mounted before an endpoint setup threw remain reachable (partial mount).
- Duplicate ids — within one source the alphabetically/declaration-first candidate wins and the duplicate is logged as an error; across sources, local wins over module.

## Rules for Agents

1. `createContext` is called exactly ONCE per extension id and the same instance flows to both the hook phase and the endpoint phase — do not rebuild context per phase.
2. `manager.emitter` and `manager.registry` are getters — treat them as read-only handles, never reassign.
3. `extensions.register` fires (via `emitInit`) and the registry seals INSIDE `loadEndpoints`, in that order — cross-extension `provide` must happen in an `init` handler subscribed to that exact event name.
4. `hook.schedule(cron, handler)` auto-namespaces the job as `ext:<id>:<cron>`; do not add your own prefix.
5. Bundle endpoint prefix rule: `endpoints` export mounts under the FIRST `entries` item with `type: "endpoint"` (falls back to the extension id if none declared); every other declared endpoint entry `X` needs its own `endpoint_X` export to mount under `/X`.
6. A default-export module is only treated as an endpoint when `manifest.type === "endpoint"` AND `manifest.bundle` is `null`/absent — a non-null `bundle` string forces hook classification even with a default export.
7. Module (npm-dependency) discovery only scans `dependencies`, never `devDependencies` — do not expect a dev-only extension package to be picked up.
8. `isEnabled` returning `false` still leaves the extension visible in `scanExtensions()` — "discovered" and "loaded" are different sets (`getExtensions()` returns loaded only).
9. Import extension-author code only from `@codihaus/fastify-extensions/types`; import the manager/emitter/registry/plugin from the root `@codihaus/fastify-extensions`.
10. `reset()` stops schedules only if the manager OWNS the emitter (i.e. no `emitter` option was injected) — an injected/shared emitter's schedules outlive that manager's `reset()`.

