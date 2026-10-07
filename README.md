# all_in_1 — Global Visual + Multi-Model + Media AI Layer for OpenCode

Built in six phases, all verified: P1 registries/roles/cost policy/project
detection, P2 browser/screenshot/artifacts, P3 vision/model catalogue/capabilities/
provider-adapter validation, P4 the gate-ordered execution layer with egress
security and live invocation, P5 the specialist layer with HITL workflow
orchestration, structured-output validation, and observability, and P6 the
OpenCode plugin binding. The whole pipeline is complete but inert under the
shipped defaults — fully exercisable offline, with zero runtime dependencies —
and the only file writers are the OpenCode tools.

## Frozen defaults (see docs/frozen-defaults.md)

- Atria-Dawn-Preview / `s1` is the immutable MAIN_CODER. The router has no code
  path that can return or override it (`resolve("MAIN_CODER")` throws
  `RoleNotRoutableError`).
- `spendBudgetUsd` default `0`.
- `FREE_ONLY` default policy; `UNKNOWN_COST` blocked by default.
- No silent free -> paid fallback. `requiresApproval` is a hard boolean.
- BUILD defaults to human-in-the-loop. `--auto` is explicit per-run opt-in and
  stays bounded by every hard limit.
- `media.enabled = false`. Media exists only as interfaces, registries, QA,
  artifact quarantine, and deterministic stubs.
- No API key is requested, displayed, stored, or logged anywhere. Secrets are
  referenced by environment-variable NAME only.

## P2 — Browser / Screenshot / Artifacts

See [docs/p2.md](./docs/p2.md). The browser engine is the only component that
launches a browser, and it enforces the localhost-only host policy *inside*
`open()` — before any navigation. Captures are stored content-addressed with
provenance sidecars. Playwright is dev-only; absence degrades to a typed
`BROWSER_UNAVAILABLE` error.

## P3 — Vision / Model Catalogue / Capabilities / Provider Adapters

See [docs/p3.md](./docs/p3.md). The vision layer turns a captured screenshot into
deterministic, schema-valid structured JSON. It has **no pricing logic of its
own**: it routes the `VISION` role through the frozen `ModelRouter`, so
`FREE_ONLY` / `spendBudgetUsd = 0` / `UNKNOWN_COST` blocking apply unchanged.
When no real model qualifies, the deterministic fake is the genuinely zero-cost
provider — so analysis never blocks on missing credentials, and the chosen
engine is always reported in the output.

The model catalogue and capability system describe models without ever calling
them (`invoke()` throws `NOT_IMPLEMENTED` in P3; the live call path is P4).
Provider isolation is enforced structurally: a model may only be served by the
adapter that owns its provider id, and only for registered capabilities.

## P4 — Execution Layer: Selection, Egress Security, Live Invocation

See [docs/p4.md](./docs/p4.md). The first real call path: the `selection.ts` P3
referenced but never shipped, a gate-ordered execution engine, a deny-all egress
boundary, call-time secret resolution, the deterministic local adapter (the only
one registered by default), and an OpenAI-compatible adapter that is **not**
registered by default. Opening a real provider takes three separate explicit
human acts — register the adapter, allowlist its host, grant the approval — and
no frozen default performs any of them. The whole pipeline is complete but
inert under the shipped defaults, and fully exercisable offline.

## P5 — Specialist Layer, HITL Workflow Orchestration, Observability

See [docs/p5.md](./docs/p5.md). The first implementation of the specialist layer
P1 declared but never wired: structured analysis only — JSON in, validated JSON
out, never a tool. A specialist routes its role onto a capability through the P3
bridge and executes **exclusively** through the P4 engine, so every policy,
approval, egress, secret, and budget gate still applies unchanged. A
dependency-free schema validator pins each specialist's output contract before a
consumer sees it. The workflow loop wires the P1 safety guard (which nothing ever
called) into a real human-in-the-loop: INSPECT analyses, SUGGEST plans, BUILD
iterates, `--auto` is an explicit opt-in bounded to five iterations, and
escalation always pauses for a human. An observability seam logs one structured
line per invocation — deriving the refusing gate from the typed error code — and
redacts provider-derived text before it reaches any sink. P5 performs **no file
writes**: the only writers are the OpenCode tools bound in P6.

## P6 — OpenCode Plugin Binding

See [docs/p6.md](./docs/p6.md). The package becomes a real OpenCode plugin, and
this closes the last open guarantee: **the OpenCode tools are the only file
writers**. The plugin registers commands only — no provider, model, tool, or
integration — and never writes a file. An edit-capable plan can only be produced
by BUILD, asserted through the P6 edit boundary at the moment such a plan is
produced; applying it stays with the human and the OpenCode `write`/`edit`/`patch`
tools.

The SDK is **bound, not depended on**: verified against `@opencode/plugin@2.0.22`,
the package is not resolvable from this project and type-checks against it pull a
transitive declaration gap. `src/opencode-plugin.d.ts` declares the verified
surface as an ambient contract, so the package type-checks deterministically with
`dependencies` empty and no `node_modules` present, while the single runtime
import in `src/plugin/index.ts` is supplied by the OpenCode host at load time.
The plugin is not auto-loaded; activating it is a change to the *user's* OpenCode
configuration, never to this package's frozen defaults.

Commands registered in OpenCode:

```
/all-in-1-inspect <subject>                    # analysis, read-only
/all-in-1-suggest <subject>                    # analysis + advisory plan
/all-in-1-build <subject> [--auto]             # edit-capable plan (HITL by default)
/all-in-1-specialist <id> <subject>            # one named specialist
/all-in-1-policy                               # the frozen defaults
```

## D7 — A Real Provider Path

The pipeline finally reaches a real model server. The additive surface:

- `src/execution/user-providers.ts` — validates a user-declared provider
  (`id`, `endpoint`, `apiKeyEnv` as an env-var NAME, models, pricing) and
  registers an `OpenAICompatibleAdapter` plus its models additively. A bad
  entry is skipped with a warning, never thrown, so one bad settings entry
  cannot break startup. Plain `http` to a non-loopback host is refused before
  any key is read.
- `OpenAICompatibleAdapter` now sends the declared tools, parses the
  provider's tool calls (decoding JSON-string arguments), renders the
  faithful `messages` conversation, derives real cost from reported token
  counts and the registered rate (never invented), supports a keyless
  loopback endpoint, and bounds retries to genuinely transient failures
  (429/5xx/transport errors) with typed errors after the budget is spent.
- The engine, the model gateway, and the specialist stack carry the
  conversation (`messages`) and surface `registrationWarnings`.
- Desktop settings gained a strictly validated `providers` list; the egress
  policy opens exactly the hosts of the registered providers — deny-all
  remains the default for a fresh install.

Everything remains inert under the frozen defaults: no providers registered,
no hosts allowlisted, budget 0.

## D8 — Provider Management in the App

The provider path from D7 is now manageable from the desktop UI:

- Settings → Model providers lists registered providers and offers Add /
  Remove. The page sends a *description* only — an endpoint, an id, model
  names, and an env-var NAME for the key — and the main-process settings
  boundary validates and sanitizes it (`sanitizeProvider`). A key value can
  never be entered or stored; changes apply after a restart, and the page
  says so.
- Startup registration warnings are surfaced, never swallowed: the stack's
  `registrationWarnings` travel through `DesktopFacade.getProviderWarnings`
  and the enumerated IPC channel `all-in-1:providers:warnings` to the
  Settings view.

## Commands (verified on Node 24.21.0 / npm 11.19.0)

```sh
npm install        # isolated to this directory; runtime deps remain ZERO
npm run typecheck  # tsc --noEmit (strict)
npm test           # vitest run
node src/cli.ts detect [path]
node src/cli.ts shot <localhost-url>
node src/cli.ts analyze <localhost-url>
node src/cli.ts select <capability>
node src/cli.ts invoke <capability> --text "..." [--allow-host host] [--policy PREMIUM_ALLOWED] [--budget usd]
node src/cli.ts specialist <role> --text "..." [--image artifact] [--schema '{...}']
node src/cli.ts workflow <INSPECT|SUGGEST|BUILD> --steps role,role [--auto true] [--plan] [--text "..."]
```

Playwright is a **dev** dependency only. The browser engine resolves it
lazily, so a production install without Playwright degrades to a typed
`BROWSER_UNAVAILABLE` error instead of a crash.

TypeScript is type-checking only: `noEmit: true`, no transpilation step, no
production runtime dependency. The plugin entry (`src/index.ts`) binds the
verified OpenCode SDK surface through an ambient contract and is **not**
auto-loaded — no OpenCode configuration change is made by this package.
