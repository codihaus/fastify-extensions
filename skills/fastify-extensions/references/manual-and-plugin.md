# Manual manager and plugin modes

Use these when the host already owns its bootstrap. Extensions are identical in every mode.

## Manual: `ExtensionManager`

```ts
import Fastify from 'fastify';
import { ExtensionManager } from '@codihaus/fastify-extensions';

const app = Fastify({ logger: true });

const manager = new ExtensionManager<AppContext>({
  manifestKey: 'orders-extension',              // required
  extensionsPath: './extensions',               // omit to skip the local scan
  moduleRoot: process.cwd(),                    // false = do not scan npm dependencies
  mustLoad: ['billing'],                        // boot fails if these do not load
  isEnabled: (id) => !disabled.has(id),         // may be async; throwing = enabled (warn)
  logger: app.log,                              // pino-compatible
  scheduleLock: redisLock,                      // ignored (with a warning) if `emitter` is injected
  onManifest: (pkg, config) => {},              // once per loaded extension
  createContext: (config) => ({                 // required; once per extension id
    extensionId: config.id,
    logger: app.log.child({ extension: config.id }),
    emitter: manager.emitter,
    registry: manager.registry,
    db,
  }),
});

await manager.scanAndLoadHooks();               // Phase 1 — hooks exist
await manager.registerServices();               // optional: seal now so host init events can consume
await manager.emitter.emitInit('app.before', { app });   // host events, if any
// ...host plugins, hooks, routes...
await manager.loadEndpoints(app);               // Phase 2 — endpoints mount (+ register/seal if not done)
await app.listen({ port: 3000 });

app.addHook('onClose', () => manager.reset());  // stop cron jobs, remove hooks
```

Rules:

- Order is fixed: `scanAndLoadHooks` → (`registerServices`) → `loadEndpoints`. Each runs
  once per cycle; `reset()` starts a new cycle.
- Without `registerServices()`, `extensions.register` fires after endpoints mount — host
  init events emitted before Phase 2 then run with an unsealed registry.
- `manager.emitter` / `manager.registry` are read-only handles.
- `reset()` stops schedules only when the manager owns its emitter (no `emitter` option).
- If `scanAndLoadHooks()` throws (missing `mustLoad`), call `manager.reset()` before
  exiting, or cron jobs keep the process alive.

Injecting a host emitter:

```ts
const emitter = new Emitter<EventContext>({ logger: app.log, scheduleLock: redisLock });
const manager = new ExtensionManager({ ..., emitter });   // pass the lock to the Emitter, not the manager
```

## Plugin: `fastifyExtensions`

```ts
import { fastifyExtensions, type ExtensionManager } from '@codihaus/fastify-extensions';

let manager: ExtensionManager<AppContext> | undefined;
await app.register(fastifyExtensions, {
  manifestKey: 'orders-extension',
  extensionsPath: './extensions',
  createContext: (config) => ({ extensionId: config.id }),
  onManager: (created) => { manager = created; },
});
```

- Runs both phases back to back; no host work in between.
- `app.register(...)` is encapsulated: routes and the `app.extensions` decorator live in the
  child scope. Use `onManager` to reach the manager outside.
- `await fastifyExtensions(app, options)` (direct call) mounts at the root and decorates
  `app.extensions` on that instance. A second direct call warns and keeps the first
  decorator.
- On boot failure the plugin resets the manager before rethrowing. `onClose` resets it on
  shutdown.

## Migrating manual → kit

| Manual code | Kit option |
|---|---|
| `new ExtensionManager({ manifestKey, extensionsPath, mustLoad, isEnabled, ... })` | `extensions: { ... }` (same fields) |
| `createContext: (config) => ({ ...shared, logger, emitter, registry })` | `context: (base) => ({ ...base, ...shared })` — `base` already has logger, emitter, registry |
| `registry.provide(...)` before Phase 2 | `services: (registry) => ...` |
| `app.register(cors)` etc. | `plugins: [...]` |
| global `addHook('preHandler', ...)` | `middlewares: (app) => ...` |
| `app.get(...)` host routes | `routes: (app) => ...` |
| `/health` route | built in (`health.checks`) |
| custom error / 404 handler | `errorHandler`, `notFoundHandler` |
| `app.listen` + signal handling + `manager.reset()` | `ServerExtension.start({ port, host })` |
| DB `destroy()` on shutdown | `onClose` |

Steps: move the bootstrap into `appOptions()`; replace `buildApp()` in tests with
`ServerExtension.create(appOptions())`; delete the hand-written health route, signal
handlers, and reset calls; run the test suite. Extensions need no change unless they read
context fields that `base` names differently (`extensionId`, `logger`, `emitter`,
`registry`, `appName`, `config`).
