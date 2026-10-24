# Writing extensions

## Contents
1. Package layout and manifest
2. Discovery
3. Module shapes
4. Hook API
5. Endpoints
6. Services between extensions
7. Schedules
8. TypeScript
9. Checklist

## 1. Package layout and manifest

An extension is an npm-package-shaped folder. The manifest lives under the host's manifest
key in `package.json`:

```jsonc
{
  "name": "@acme/order-policy",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "orders-extension": {
    "id": "order-policy",          // optional; default = folder name (local) or package name (npm)
    "type": "hook",                // optional; "endpoint" for a default-export endpoint
    "path": "dist/index.js",       // optional entry override
    "entries": [                   // bundles only
      { "type": "hook", "name": "policy" },
      { "type": "endpoint", "name": "orders" }
    ]
  }
}
```

Entry resolution, first match wins: manifest `path` → `main` → `dist/index.js`.

Extra manifest fields are allowed and reach the host's `onManifest(pkg, config)` callback —
use them for host-specific metadata (permissions, UI hints).

Prefer an explicit `id` for npm packages: the default id of `@acme/order-policy` is the full
scoped name, which becomes the route prefix of a default-export endpoint.

## 2. Discovery

- **Local**: every subfolder of `extensionsPath` whose `package.json` has the manifest key.
  Loaded in alphabetical order.
- **npm**: every package in the host `dependencies` (never `devDependencies`) whose
  `package.json` has the manifest key. Packages with a strict `exports` map are found too.
- Same id in both: local wins. Same id twice in one source: the first wins, an error is
  logged.
- `isEnabled(id) === false` skips loading; the extension still appears in
  `manager.scanExtensions()`.

## 3. Module shapes

**Hook** — default export, manifest without `type: "endpoint"`:

```ts
import { defineHook } from '@codihaus/fastify-extensions/types';
export default defineHook<AppContext>((hook, context) => { /* ... */ });
```

**Endpoint** — default export, manifest `"type": "endpoint"`, mounted at `/<id>`:

```ts
import { defineEndpoint } from '@codihaus/fastify-extensions/types';
export default defineEndpoint<AppContext>((router, context) => {
  router.get('/list', async () => context.db.orders);   // GET /<id>/list
});
```

**Bundle** — named exports, manifest `entries`:

```ts
export const hooks = defineHook<AppContext>((hook, context) => { /* Phase 1 */ });
export const endpoints = defineEndpoint<AppContext>((router) => { /* mounted at /<first endpoint entry> */ });
export const endpoint_admin = defineEndpoint<AppContext>((router) => { /* mounted at /admin, needs entry "admin" */ });
```

A module that matches none of these is skipped with `Unrecognized extension shape`.

## 4. Hook API

```ts
defineHook<AppContext, EventContext>((hook, context) => {
  hook.filter<Order>('orders.create', async (order, meta, eventContext) => {
    if (order.amount <= 0) throw new Error('amount must be positive');   // stops the pipeline
    return { ...order, normalized: true };                              // must return the payload
  });

  hook.action('orders.created', async (meta, eventContext) => {
    await notify(meta.order);                                            // errors are logged only
  });

  hook.init('extensions.register', () => {
    context.registry.provide(pricingRef, createPricing(context));        // the only place to provide
  });

  hook.init('routes.before', ({ app }) => { /* kit lifecycle event, registry already sealed */ });

  hook.schedule('*/5 * * * *', async () => { /* cron */ });
});
```

Event patterns: exact `orders.create`, all `*`, prefix `orders.*`, suffix `*.created`.
Wildcards match whole dot segments (`*.create` does not match `recreate`). The `event` key of
`meta` always holds the real event name.

Emitting from host or endpoint code:

```ts
const order = await context.emitter.emitFilter('orders.create', input, {}, eventContext);
context.emitter.emitAction('orders.created', { order }, eventContext);
await context.emitter.emitInit('my.startup.step', { app });
```

The hook function itself may be async; the loader awaits it, so registrations after an
`await` still count.

## 5. Endpoints

- `router` is a scoped Fastify instance with the prefix applied. Use any Fastify feature:
  schemas, `preHandler`, `reply.view`, decorators of the root app.
- Root-level hooks and decorators from the host (auth, `request.user`, `reply.view`) apply
  inside extension routes.
- A setup function that throws discards the extension (its hooks are cleaned up). Routes it
  added before throwing stay mounted.
- Consume services per request — always safe. Consuming at setup time (top of the endpoint
  function) is safe in the kit and in manual hosts that call `registerServices()`; in a
  manual host that skips it, endpoints mount before the registry seals and `consume()` throws.

## 6. Services between extensions

Contract module (shared package or host `src/contracts.ts`):

```ts
import { createServiceRef } from '@codihaus/fastify-extensions/types';
export interface PricingService { quote(productId: string): number }
export const pricingRef = createServiceRef<PricingService>('pricing');
```

Provider:

```ts
hook.init('extensions.register', () => context.registry.provide(pricingRef, { quote }));
```

Consumer:

```ts
router.get('/quote/:id', async (request) => {
  const pricing = context.registry.consume(pricingRef);         // throws if absent
  return { price: pricing.quote(request.params.id) };
});
const audit = context.registry.tryConsume(auditRef);            // undefined if absent — optional dependency
```

Error messages tell you which mistake happened:

- `consumed before registry sealed` → you consumed at the top level of a hook. Move it into a
  handler or a later init event.
- `No provider for service "x"` → the provider is not installed, disabled, or provides under
  another id.

## 7. Schedules

```ts
hook.schedule('0 3 * * *', async () => { await cleanup(context.db); });
```

- 5-field cron. An invalid expression is logged and skipped (no throw).
- Job name: `ext:<id>:<cron>`; a repeated cron in the same extension gets `#2`, `#3`.
- Handler errors are logged, never thrown.
- Single process: default lock is fine. Several replicas: the host must pass a shared
  `ScheduleLock`, otherwise each replica runs each tick.
- Cron jobs stop on `kit.close()` / `manager.reset()`.

## 8. TypeScript

- Type the context: `defineHook<AppContext>` / `defineEndpoint<AppContext>`. The second
  generic of `defineHook` types the event context passed to filters and actions.
- Production: compile extensions to `dist/index.js` and point `main` there.
- Development: `.ts` entries (`"main": "index.ts"`) load when the host runs under `tsx`
  (`tsx src/server.ts`). Use `.js` in relative import specifiers with `NodeNext` resolution.
- Route generics work as usual: `router.post<{ Body: Order }>('/orders', ...)`.

## 9. Checklist

- [ ] `package.json` has the exact host manifest key and `"type": "module"`.
- [ ] Imports come only from `@codihaus/fastify-extensions/types` and the contract module.
- [ ] Services are provided in `init('extensions.register')` and consumed later.
- [ ] Filters return the payload; validation errors are thrown from filters, not actions.
- [ ] Event names are semantic and documented by the host.
- [ ] Schedules are idempotent (safe if a tick runs twice or is skipped).
- [ ] Resources opened by the extension are released through `context.onShutdown` (kit) or
      the host's shutdown.
- [ ] An endpoint prefix collision with another extension or host route is ruled out.
