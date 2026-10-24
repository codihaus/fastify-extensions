# Troubleshooting

## An extension does not load

Check in order; most cases stop at the first three.

1. `kit.manager.scanExtensions()` (or `manager.scanExtensions()`) — is the id discovered?
   - No → the folder is not directly under `extensionsPath`, or the package is not in host
     `dependencies` (devDependencies are ignored), or the `package.json` lacks the exact
     manifest key, or `moduleRoot` is `false`.
2. Logs at warn/error level:
   - `Invalid extension manifest, skipping` → fix the listed manifest fields.
   - `Duplicate extension id` → two packages resolve to the same id; set a unique `id`.
   - `Failed to import extension` → bad entry path (`path` / `main` / `dist/index.js`),
     missing build output, or a syntax/import error inside the extension.
   - `Unrecognized extension shape, skipping` → no default function, no `hooks`/`endpoints`,
     and no `endpoint_<name>` matching a declared entry.
   - `Failed to load extension hooks in Phase 1` → the hook function or `createContext` threw.
   - `Failed to register extension endpoints in Phase 2 — extension discarded` → the endpoint
     setup threw; routes added before the throw remain.
3. `isEnabled(id)` returned `false` (logged at debug as `Extension disabled, skipping`).
4. Local and npm copies share the id → the local one wins.

## Error messages

| Message | Cause | Fix |
|---|---|---|
| `Required extension "x" failed to load. Cannot start server.` | `x` is in `mustLoad` but was not loaded (missing, disabled, or failed) | Read the earlier error for `x`; fix it or remove it from `mustLoad` |
| `Service "x" consumed before registry sealed` | `consume()` at hook top level, or in an init event that fires before `extensions.register` (manual mode without `registerServices()`) | Consume in a handler or a later event; in manual mode call `registerServices()` before host init events |
| `No provider for service "x"` | provider missing, disabled, or uses another id | Install/enable the provider; import the same ref from the contract module |
| `provide("x") after registry sealed` (warn) | `provide()` outside `init('extensions.register')` | Move it into that init handler |
| `service "x" already provided — overriding` (warn) | two providers for one id | Keep one, or give them distinct ids |
| `scanAndLoadHooks() called in phase ...` / `loadEndpoints() already ran` | phase method called twice | Call `reset()` between cycles |
| `registerServices() called in phase ...` | called before Phase 1 or after Phase 2 | Call it between the two phases |
| `listen() called in state ...` | `kit.listen()` twice, or after `close()` | Listen once; `start()` already listens |
| `View engine "pug" needs the "pug" package` | engine selected but not installed | `npm install pug` (or `twig`) in the host |
| `Unsupported view engine "x"` | engine outside liquid/pug/twig | Use one of the three, or `view: false` and register `@fastify/view` yourself |
| Fastify `Not found handler already set` | host calls `setNotFoundHandler` while the kit default is on | Pass `notFoundHandler: fn` to the kit, or `notFoundHandler: false` |
| `"scheduleLock" is ignored when "emitter" is injected` (warn) | both options passed to the manager | Pass the lock to the injected `Emitter` |
| `Invalid cron expression for schedule ...` (warn) | bad cron string | Use 5 fields: minute hour day month weekday |

## Behavior that surprises people

- **A cron job runs on every replica.** The default `MemoryScheduleLock` always claims. Pass a
  shared lock.
- **An action's effect is not visible right after the request.** Actions are fire-and-forget.
  In tests, `await setImmediate()` first; in production, use a filter or a direct call when
  the caller needs the result.
- **A thrown filter returns 500.** Catch it in the endpoint and map it to 400, or throw an
  error with `statusCode = 400` — the kit error handler keeps 4xx messages and hides 5xx.
- **Test runner does not exit.** A cron job is still running. `await kit.close()` (or
  `manager.reset()`) in `finally` / `afterEach`.
- **`app.extensions` is undefined after `app.register(fastifyExtensions)`.** Encapsulation —
  use `onManager`, or call `fastifyExtensions(app, options)` directly.
- **A route from a failed extension still answers.** Fastify cannot unmount routes. Fix the
  extension and restart.
- **HTML shows `&lt;b&gt;`.** Views escape by default. Mark trusted HTML with `| raw`
  (Liquid/Twig) or `!{}` (Pug) — never for user input.
- **`/health/ready` returns 503 before listen in tests.** It returns 200 once the kit is
  `ready`; `create()` resolves only after that. A 503 means a check failed or timed out —
  see the warn log `Readiness check failed`.
