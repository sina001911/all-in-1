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

## D9 — Honest Models View

The Models view now reports the provider path truthfully:

- A "Your providers" card lists each user-registered provider with its
  endpoint, models, locality, cost class, credential *presence* (never a
  value), and whether the engine registered it. New channel
  `all-in-1:models:providers` → `DesktopFacade.listModelProviders()`.
- The selection posture stops lying: with no providers it still states
  deny-all egress; once providers exist it names them and the actual
  egress allowlist, and it keeps stating that the budget and FREE_ONLY
  cost policy remain the binding bounds.

## D10 — Hot-reload Providers Without Restart

A provider settings change now applies immediately. The patch path is:
settings patch → sanitize (unchanged D8 boundary) → if `providers` changed →
`reloadProviders()`:

- Only the provider-dependent core is rebuilt: catalog, capabilities,
  chains, adapters, egress policy, engine, and specialist runner.
- The swap is atomic from the caller's perspective: the provider catalogue,
  engine, and egress policy move together as references on `DesktopStack`.
- The pre-existing `SwappablePortal` reference the agent gateway (and so the
  agent runtime) holds is repointed to the new engine; in-flight agent turns
  keep their original engine.
- If the rebuild throws (the settings sanitizer already bounds input,
  defensively), nothing is replaced: the previous stack continues to serve.
- The same stores, approvals, budget ledger, run/usage stores, log store,
  credentials, cancellation hub, tool runtime, and workspace roots are
  reused — hot-reload touches none of them.

## D11 — Streaming Responses

The OpenAI-compatible adapter can now stream:

- A request with `streaming: true` sends `"stream": true` and
  `"stream_options": { "include_usage": true }` and assembles the frame
  stream back into the SAME `ProviderInvokeResult` contract as the
  buffered path — the caller sees the assembled outcome; fragments travel
  only onto the optional `InvokeOptions.onStreamEvent` sink.
- Stream frames (`data:` / SSE with a tolerant keepalive tolerant parser,
  same transport seam as `post`) are typed as `StreamEvent`: `text`,
  `tool-call-delta`, `finish`, `usage`.
- Retry is bounded and happens only BEFORE the first delivered event; once
  any delta has flowed, a failure is typed `PROVIDER_STREAM_INTERRUPTED` —
  never a replay, never a partial success.
- Timeouts and caller cancellation abort the underlying socket, not just
  the caller's wait: the `InvocationPortal`/engine passes one
  `AbortController` through to the transport.
- Cost derives from the provider's own usage frame (rate × reported
  tokens); without a usage frame, cost is exactly 0 — nothing is invented.
- User-declared models may set `streaming: true`; the selector only
  routes streaming requests to models that declared it, so the honest
  fallback for non-streaming descriptors is an honest `SELECTION_FAILED`,
  never a silent buffer.
- D10 holds: an in-flight stream continues on the pre-reload engine, and a
  reload mid-stream installs the new engine for subsequent requests only.

UI consumer for progressive rendering is deferred (D10 did not promise one).

## D12 — Progressive Agent UI

The agent turn now supports an opt-in streaming preview channel without
altering the result contract or persistence model:

- `AgentRequest.streaming` / `GatewayTurnRequest.streaming` forward through
  the loop into `ProviderModelGateway.turn`, into the engine, and onto the
  adapter — so a streaming turn is still gated by the same gates,
  settling, and cost machinery.
- `AgentStreamBridge` is the main-process in-memory bridge: keyed by run id,
  cursor-advanced, bounded, and terminated as done/failed. It never
  persists, never writes into RunStore/UsageStore, and never confuses two
  concurrent runs.
- A new enumerated IPC channel `all-in-1:agent:stream` lets the renderer
  pull progressive frames; the renderer still assembles the final transcript
  from `AgentResult` alone. The final render REPLACES any in-progress row,
  so nothing is duplicated.
- Local deterministic models advertise `streaming: true` and satisfy a
  streaming request with exactly one complete text frame + one finish frame —
  no token-level claim.
- Cancellation and timeout keep flowing through `CancellationHub` into the
  engine and adapter; no parallel cancellation mechanism is introduced.

## D13 — Live SSE Acceptance

The D11 adapter is now also exercised against a real loopback HTTP server:
one socket, one SSE stream, the same gates and result contract, no fake
transport. Cost comes only from the provider's usage frame; a hung body is
aborted by the engine timeout, never waited on, and no budget reservation
is ever committed as zero.

## D14 — Operator CLI Stream

`node src/cli.ts stream <capability>` exposes the D11/D12 streaming path to
an operator without a desktop UI. It shares the engine/transport contract:

- stdout stays final-machine-readable JSON (same fields as `invoke`);
- stderr carries each `StreamEvent` as `data: {...}` for operator logging;
- `--provider-json`/`--provider-file` and `--allow-host` feed the same
  `buildExecutionStack` wiring as `invoke`;
- `--timeout` and SIGINT both flow into the engine's abort path.

`invoke` is unchanged: no frames on stderr, one final JSON on stdout.

## D15 — Workflow Streaming

`WorkflowLoop` and specialist runner now have an opt-in streaming path:

- `WorkflowRequest.streaming` and an optional `onStreamEvent` sink forward
  into `SpecialistRunner.run` for every step;
- the runner marks the selection request streaming so the engine can stream
  the resulting provider frames;
- the final workflow contract is unchanged: buffered `StepResult`/`WorkflowResult`
  objects, no persistence side effect, same timeout/signal propagation.

## D16 — Workflow Stream Desktop Bridge

Desktop can now stream the diagnostic workflow progressively while keeping
the final `DiagnosticResult` authoritative:

- `DiagnosticRequest.streaming` turns on bridge emission; `runId` is optional
  and generated once when absent; both forwarded to the workflow bridge.
- `DesktopFacade.getWorkflowStream(runId, cursor)` summarizes what has
  arrived so the renderer can show progressive rows without a push channel.
- Workflow stream events in the desktop renderer stay UI-only; final
  `DiagnosticResult.text` replaces the preview.
- Agent bridge (`getAgentStream`) is untouched; workflow has its own
  independent runId namespace via `workflowStreamBridge`.

## D17 — Streaming Hardening

Terminal bridge state is now short-lived, never retained forever:

- `AgentStreamBridge` lazily prunes entries that have been `done`/`failed` for
  longer than its terminal retention window (default 30 s).
- Running entries are never pruned; only completed/failed flows are cleaned up.
- Public pull contract (`getSince`/`getAgentStream`/`getWorkflowStream`)
  is unchanged: once an entry is pruned it returns `undefined`, which both the
  agent and workflow UIs already treat as the end of the poll.

## D18 — Workflow Progress Renderer

The desktop renderer can now render workflow progress only as a transient
overlay. When `diag-stream` is checked it polls the existing
`getWorkflowStream` endpoint, renders text/usage/finish/failure markers, and
stops polling at terminal state. The final `DiagnosticResult.text` still
replaces this preview entirely — the stream never persists.

## D19 — Unified Progress State Rendering

Agent and workflow streams now use the same transient-marker format in the
renderer:

- `[workflow tool fragment]` for the tool frame;
- `[usage: prompt+completion]` for usage frames;
- `[finish: ...]` for finish frames;
- if a run fails, `[failed: <code> — <message>]` appears.

The final `AgentResult` / `DiagnosticResult` always replaces the live preview.
This change is renderer-only; bridge contract, IPC, storage and provider
payloads are untouched.

## D20 — Facade Streaming Lifecycle

The desktop facade now has a dedicated lifecycle harness over both streaming
bridges. `streamBridge` and `workflowStreamBridge` stay separately keyed, their
terminal state is reported through the facade query shape, and cancellation/
timeouts land in the same typed envelope as the existing core path.

## D21 — Provider Validate / Test Before Save

Settings > Model providers can now probe a provider config before saving.
The add-provider modal adds a `Test config` button:

- Sends the raw provider object through `facade.testProviderConfig`.
- Validates the same sanitizeProvider rules used for Save.
- If an api key env name is declared, ensures the variable is set before probing.
- Probes only `GET {{endpoint}}/models` — no Chat Completions request, no
  business prompt, no accidental spend.
- Result is shown inline; if the endpoint is unreachable or the models list is
  incomplete the typed detail is `ok:false` + `code`, but the UI never blocks
  Save.

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
