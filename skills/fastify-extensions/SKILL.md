---
name: fastify-extensions
description: >-
  Build consumer projects on @codihaus/fastify-extensions: boot a Fastify app in one call
  with the ServerExtension app kit, wire the manual ExtensionManager or the
  fastifyExtensions plugin, and write extension packages (hook, endpoint, bundle) with
  manifests, typed context, filter/action/init events, shared services
  (createServiceRef, provide, consume), cron schedules, health probes, graceful shutdown,
  and Liquid/Pug/Twig views. Use it whenever a project imports
  @codihaus/fastify-extensions, has an "*-extension" manifest key in package.json, calls
  ServerExtension / defineHook / defineEndpoint, or the user asks to "tạo app kit",
  "khởi tạo app fastify có extension", "viết extension", "thêm hook/endpoint/service/
  schedule", "extension không load", "migrate sang ServerExtension" — even without naming
  the package. Not for changing the library itself (use its CLAUDE.md / AGENTS.md) and not
  for ODP core extensions on @odp/api.
---

# @codihaus/fastify-extensions — consumer guide

This package gives a Fastify host an extension kernel: it discovers extension packages,
loads them in two phases (hooks before the server, endpoints after), injects a host-typed
context, and coordinates a shared emitter and a service registry. On top of it, the app kit
(`ServerExtension`) builds a complete app in one call.

Extensions are trusted Node.js code. The package governs architecture; it is not a sandbox.

## Step 1 — decide the role

| The task is about... | Role | Import from |
|---|---|---|
| booting the app, choosing discovery, context, policies, routes, shutdown | **host** | `@codihaus/fastify-extensions` |
| a package that adds hooks, routes, services, schedules into a host | **extension author** | `@codihaus/fastify-extensions/types` only |

An extension never imports the manager, the loader, or another extension's implementation.
It talks to the host only through its injected context, hook API, events, and service refs.
This keeps extensions swappable and lets the host change its internals freely.

## Step 2 — host: pick the boot mode

| Mode | Use when | Reference |
|---|---|---|
| **Kit** `ServerExtension.start(options)` | New app, or the host wants Fastify + extensions + health + request id + error handling + views + graceful shutdown with no boilerplate. **Default choice.** | `references/kit.md` |
| **Manual** `ExtensionManager` | The host already owns a custom bootstrap and needs exact control of each step. | `references/manual-and-plugin.md` |
| **Plugin** `fastifyExtensions` | Only mount extensions into an existing app, no host events between phases. | `references/manual-and-plugin.md` |

Minimal kit app:

```ts
import { ServerExtension } from '@codihaus/fastify-extensions';

await ServerExtension.start({
  name: 'orders',
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '127.0.0.1',          // '0.0.0.0' in containers
  extensions: { manifestKey: 'orders-extension', extensionsPath: './extensions' },
  context: (base) => ({ ...base, db }),             // typed context for every extension
  routes: (app) => app.get('/', async () => ({ ok: true })),
  onClose: () => db.destroy(),
});
```

Put the options in a function (`appOptions()`) shared by `server.ts` (`start`) and tests
(`create` + `app.inject`). That is the pattern in `examples/kit-app` of the package repo.

## Step 3 — extension author: pick the shape

| Shape | Exports | Manifest | Mounted at |
|---|---|---|---|
| Hook | `export default defineHook(...)` | `{}` or `{ "type": "hook" }` | — |
| Endpoint | `export default defineEndpoint(...)` | `{ "type": "endpoint" }` | `/<id>` |
| Bundle | `hooks`, `endpoints`, `endpoint_<name>` | `entries: [...]` | first endpoint entry, `/<name>` |

Full authoring guide, manifest fields, services, schedules, views, TypeScript setup:
`references/extensions.md`.

## Rules that prevent most bugs

1. **Provide services only in `hook.init('extensions.register', ...)`.** The registry seals
   right after that event. Consume in request handlers, actions, or later init events —
   never at the top level of a hook function, where nothing is provided yet.
2. **Share a `ServiceRef` from a contract module.** Provider and consumer import the same
   `createServiceRef<T>('id')`; the runtime key is the string id, the type rides along.
3. **Pick the right event tier.** Filter = sequential transform, errors propagate (use it for
   validation). Action = fire-and-forget side effect, errors logged. Init = ordered startup
   step, errors stop boot. Name events semantically: `orders.create` (filter) /
   `orders.created` (action).
4. **`createContext` (or kit `context`) runs once per extension.** Build per-extension
   things there (child logger, scoped config); share expensive resources (DB pool) by
   closure.
5. **Schedules:** use `hook.schedule(cron, handler)`; do not add the `ext:<id>:` prefix
   yourself. `MemoryScheduleLock` is single-process. With more than one replica, pass a
   Redis- or DB-backed `ScheduleLock` (`extensions.scheduleLock`), or every replica runs
   every tick.
6. **Keep invariants in the host.** Transactions, authorization, and anything that must not
   be skipped stay in host code. Expose filters/actions at deliberate seams, not on every
   internal function.
7. **Routes cannot be unmounted.** `reset()` / shutdown remove hooks, actions, inits, and
   schedules only.

## Kit defaults you will meet

Each can be switched off with `false` or overridden. The kit is a flexible starter: prefer
overriding a default to fighting it.

| Option | Default behavior |
|---|---|
| `health` | `GET /health`, `/health/live`, `/health/ready` answered before any host hook; `/ready` runs `checks` with a timeout, 503 on failure or during shutdown |
| `requestId` | safe `x-request-id` header → request id, else UUID; echoed on every reply |
| `acceptEmptyJson` | empty `application/json` body parses as `undefined` |
| `errorHandler` | Fastify-shaped error body; 5xx message replaced by `Internal Server Error` and logged |
| `notFoundHandler` | `ROUTE_NOT_FOUND`, query string omitted. If the host wants its own, pass `notFoundHandler: fn` — calling `app.setNotFoundHandler` inside `routes` throws because one is already set |
| `view` | Liquid, templates in `<cwd>/views`, HTML auto-escaped; `{ engine: 'pug' \| 'twig' }` needs that package installed |
| `fastify.logger` | `{ level: 'info' }` unless `logger` / `loggerInstance` is passed |

## Verify before handing work back

- Boot the app (`ServerExtension.create` in a test, or `start` + `curl`) and check
  `kit.extensions` lists every expected id.
- Hit at least one extension route and `/health/ready`.
- If services are involved, call a route that consumes them (proves sealing order).
- If `mustLoad` is set, confirm a missing id fails boot with
  `Required extension "<id>" failed to load`.
- Run the project's typecheck; extension code should type-check against the host context
  (`defineHook<AppContext>`, `defineEndpoint<AppContext>`).
- Close the app (`kit.close()`) in tests so cron jobs stop and the test runner exits.

When something does not load or throws at boot, use `references/troubleshooting.md` — it
maps each error message to its cause and fix.
