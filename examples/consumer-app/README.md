# consumer-app — sample host for `@codihaus/fastify-extensions`

A runnable Fastify host that loads three local extensions from `./extensions`, each
demonstrating a different capability of the package. Zero build step — plain ESM run
with `node`.

## Run

```bash
# from the repo root, make sure the package is built first:
npm run build

cd examples/consumer-app
npm install          # installs fastify + the local package via file:../..
npm start            # boots on http://127.0.0.1:3100  (override with PORT=…)
```

Then:

```bash
curl localhost:3100/                         # what got loaded
curl localhost:3100/store/products
curl -X POST localhost:3100/store/orders -H 'content-type: application/json' -d '{"product":"p1","amount":9.99}'
curl -X POST localhost:3100/store/orders -H 'content-type: application/json' -d '{"amount":-5}'   # 400, filter rejects
curl localhost:3100/store/analytics          # reads the cross-extension service
curl localhost:3100/audit/log                # audit trail (wildcard action)
curl localhost:3100/health                   # bundle's second endpoint
```

## How the host wires it up (`server.mjs`)

- Defines its **own** context shape (`AppContext`) — the package is generic and assumes
  nothing about it. Here it carries a fake `db`, a child `logger`, and handles to the
  shared `emitter` and `registry`.
- Uses the **two-phase** `ExtensionManager`: `scanAndLoadHooks()` (Phase 1, before the
  server exists) then `loadEndpoints(app)` (Phase 2, which also emits `extensions.register`
  and seals the registry).
- `createContext(config)` is called once per extension; the same object instance reaches
  both the hook phase and the endpoint phase.

## The three case studies

### 1. `extensions/analytics` — a hook extension

A single default export treated as a hook (manifest has no `type`). It exercises every
hook capability:

| Capability | What it does |
|---|---|
| `hook.filter('order.create', …)` | Validates + enriches each order; throwing rejects the whole `emitFilter`, so the store endpoint returns 400. |
| `hook.init('extensions.register', …)` | Provides an `AnalyticsService` into the registry during the one safe provide window. |
| `hook.action('order.created', …)` | Fire-and-forget: updates running totals; errors here are logged, never thrown. |
| `hook.schedule('*/1 * * * *', …)` | A cron heartbeat, coordinated by the default `MemoryScheduleLock`. |

### 2. `extensions/store` — an endpoint extension

Manifest `type: "endpoint"`, so it mounts under `/store` (the extension id). It shows the
consumer side of everything:

- Serves `GET /store/products`, `POST /store/orders`, `GET /store/analytics`.
- `POST /store/orders` drives the shared emitter: `emitFilter('order.create', …)` (validated
  by analytics) then `emitAction('order.created', …)` (observed by analytics + audit).
- `GET /store/analytics` **consumes** the `AnalyticsService` at request time — long after
  the registry is sealed, which is exactly when consuming is safe.

### 3. `extensions/audit` — a bundle

One package exporting `hooks`, `endpoints`, and `endpoint_health`, with an `entries` array
in the manifest that drives the prefixes:

- `hooks` subscribes to `action('*')` — a wildcard that audits every action event.
- `endpoints` mounts under `/audit` (the first `endpoint` entry name) → `GET /audit/log`.
- `endpoint_health` mounts under `/health` (matches the `health` entry) → `GET /health`.

## The shared service contract (`contracts.mjs`)

The provider (`analytics`) and the consumer (`store`) import the **same** `analyticsRef`
from `contracts.mjs`. That is the intended pattern: a small shared module holds the typed
`ServiceRef`, so neither extension depends on the other directly.

## Typing note

These extensions are plain `.mjs` for a zero-build demo, but they still import the
`defineHook` / `defineEndpoint` / `createServiceRef` helpers from
`@codihaus/fastify-extensions/types`. In a TypeScript host you would publish your own
`AppContext` type and re-export those helpers pre-bound to it, so authors get full
type-checking of `context` — see the main README's "Publishing your own typed
extension-author surface" section.
