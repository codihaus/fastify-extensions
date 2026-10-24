# @codihaus/fastify-extensions — Claude Guide

Use this file when integrating `@codihaus/fastify-extensions` into a host application or
when authoring an extension package.

Read [AGENTS.md](./AGENTS.md) before changing code. It is the canonical, detailed contract
for discovery, manifests, lifecycle, event tiers, service registration, scheduling, cleanup,
and known limitations. This file is the shorter execution guide for Claude.

Consumer projects (hosts and extension authors) can load the bundled skill at
[`skills/fastify-extensions/`](./skills/fastify-extensions/SKILL.md). It ships in the npm
package under `node_modules/@codihaus/fastify-extensions/skills/`.

## First decide which role you are implementing

### Host application

The host owns:

- `manifestKey`;
- extension discovery sources;
- enablement and `mustLoad` policy;
- the typed context passed to extensions;
- named filter/action/init boundaries;
- service-registry timing;
- Fastify route mounting;
- schedule coordination and process lifecycle.

Import host runtime APIs from the package root:

```ts
import {
  ServerExtension,
  ExtensionManager,
  Emitter,
  MemoryScheduleLock,
  fastifyExtensions,
} from '@codihaus/fastify-extensions';
```

### Extension package

An extension contributes behavior inside boundaries published by the host. It must not
reach into undocumented host globals or import the manager/loader.

Import authoring helpers and types from the loader-free subpath:

```ts
import {
  createServiceRef,
  defineEndpoint,
  defineHook,
} from '@codihaus/fastify-extensions/types';
```

## Choose the correct boot model

Use the app kit when the host wants Fastify, extensions, health probes, request ids, error
handling and graceful shutdown in one call:

```ts
import { ServerExtension } from '@codihaus/fastify-extensions';

const kit = await ServerExtension.start({
  name: 'myapp',
  port: 3000,
  extensions: { manifestKey: 'myapp-extension', extensionsPath: './extensions' },
  context: (base) => ({ ...base, db }),
  routes: (app) => { app.get('/', async () => ({ ok: true })); },
  onClose: () => db.destroy(),
});
```

Use `ServerExtension.create(options)` in tests (no listen, no signal handlers). The kit
seals the registry before `app.before`, so extensions can `consume()` inside every kit init
event. See AGENTS.md "App Kit" for the full boot order and rules.

Kit defaults, each one can be turned off with `false`: `health` probes, `requestId`,
`acceptEmptyJson`, `errorHandler`, `notFoundHandler`, and `view` (Liquid via
`@fastify/view`; `pug` / `twig` when the host installs them). Output escaping is on for all
three engines.

Use the two-phase manager when extensions must observe host events before Fastify routes
and plugins have finished mounting:

```ts
const manager = new ExtensionManager({
  manifestKey: 'myapp-extension',
  extensionsPath: './extensions',
  createContext,
});

await manager.scanAndLoadHooks();

// Build the host and emit any early application events here.

await manager.loadEndpoints(app);
```

Use the Fastify wrapper only when no host work is required between those phases:

```ts
await app.register(fastifyExtensions, {
  manifestKey: 'myapp-extension',
  extensionsPath: './extensions',
  createContext,
  onManager: (manager) => {
    extensions = manager;
  },
});
```

Remember that `app.register()` is encapsulated. The outer `app.extensions` is not decorated.
Use `onManager`, or call `await fastifyExtensions(app, options)` directly when root-level
routes and decoration are intentional.

## Lifecycle invariants

Do not violate these rules:

1. `createContext` runs exactly once per loaded extension id. Reuse that context across both
   phases.
2. Run `scanAndLoadHooks()` before `loadEndpoints(app)`. Call `registerServices()` between
   them when host init events emitted before Phase 2 must see sealed services.
3. Each phase is one-shot per cycle. Call `reset()` before beginning another cycle.
4. Register service providers from an init handler for the exact
   `extensions.register` event.
5. The manager seals the registry immediately after that init event. Do not call internal
   `seal()` or `reset()` methods from host code.
6. Treat `manager.emitter` and `manager.registry` as read-only handles.
7. `reset()` stops schedules only when the manager owns its emitter.
8. Fastify routes cannot be unmounted. Cleanup removes hook-, action-, init-, and
   schedule-side registrations only.

## Pick the correct event tier

| Need | Tier | Behavior |
|---|---|---|
| Transform or validate pipeline data | Filter | Sequential, awaited, failure stops the pipeline |
| Trigger independent side effects | Action | Fire-and-forget, errors isolated per handler |
| Perform ordered startup registration | Init | Sequential, awaited, failure stops init |

Use semantic event names such as `orders.create` and `orders.created`. Do not expose a hook
for every internal function. Keep domain invariants, transaction boundaries, mandatory
security guarantees, and correctness-critical failure behavior inside the host core.

## Manifest checklist

Every extension directory must be npm-package-shaped and contain the host-selected manifest
key:

```jsonc
{
  "name": "@acme/order-policy",
  "type": "module",
  "main": "dist/index.js",
  "myapp-extension": {
    "id": "order-policy",
    "type": "hook"
  }
}
```

Before debugging a missing extension, verify:

- the package is under `extensionsPath` or listed in host `dependencies`;
- it is not only in `devDependencies`;
- its package.json contains the exact host `manifestKey`;
- its manifest passes validation;
- `isEnabled(id)` does not return `false`;
- its entry resolves by manifest `path`, package `main`, or `dist/index.js`;
- its exports match a supported module shape;
- its id does not lose a duplicate-id conflict.

Local extensions take precedence over installed dependencies with the same id.

## Service-sharing checklist

- Put `ServiceRef` values and interfaces in a small contract package.
- Providers and consumers import the same ref.
- Providers call `provide` during `extensions.register`.
- Consumers resolve services only after loading is complete, typically inside request or
  event handlers.
- Use `tryConsume` only when absence is genuinely optional.
- Do not make extension packages import one another's implementation.

## Scheduling checklist

- Use `hook.schedule(cron, handler)` inside extensions.
- Do not manually add the `ext:<id>:` prefix; the hook context does that. A repeated cron in
  the same extension gets a `#2`, `#3`, ... suffix.
- The default `MemoryScheduleLock` is for a single process.
- Supply a Redis- or database-backed `ScheduleLock` for replicated deployments.
- Treat scheduled handlers as trusted server-side code with normal process permissions.

## Error and trust model

Extension import and registration failures are isolated unless a required extension is
missing. Filter and init errors propagate by design; action and schedule errors are logged
and isolated.

Extensions are trusted Node.js modules. This package provides architectural governance, not
a VM, worker, process, permission, filesystem, network, environment, or secret sandbox.

## Working on this repository

Source layout (details in AGENTS.md "Source Layout"):

```
src/index.ts   public barrel        src/types.ts   ./types subpath (runtime-free)
src/kernel/    manager, discovery, loader, registry — no Fastify runtime import
src/runtime/   emitter, schedule, logger
src/plugin/    fastify-extensions.ts (one-phase plugin)
src/kit/       ServerExtension + options, http-defaults, health, shutdown, view
```

- Keep the dependency direction: `kit` and `plugin` → `kernel` → `runtime` → `types`.
- Keep `src/index.ts` and `src/types.ts` at the root; they are the tsdown entries behind the
  `exports` map.
- The kit is a fast, flexible starter. Prefer secure defaults the host can override, and warn
  instead of throw on misconfiguration. Do not remove escape hatches.
- Add a regression test for every bug fix and check it fails on the old code.
- `package.json` drives the published version (see `.github/DEPLOYMENT.md`). Do not bump it
  unless asked.

## Validation before handing work back

For changes to this package, run:

```bash
npm run typecheck
npm test
npm run test:types
npm run build
npm pack --dry-run
(cd examples/consumer-app && npm test)
(cd examples/kit-app && npm install && npm run typecheck && npm test)
```

For host or extension integrations, additionally verify:

- boot order is correct;
- both local and installed discovery paths behave as intended;
- required extensions fail startup clearly;
- service consumption happens after registry sealing;
- endpoint prefixes match the manifest/module shape;
- schedules use the deployment-appropriate lock;
- shutdown calls `manager.reset()` when the host owns the lifecycle.
