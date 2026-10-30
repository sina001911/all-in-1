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
- `PREFERRED_FREE` default policy (D31): paid models are selectable with
  explicit approval, but the budget gate still refuses any spend at zero
  budget. `UNKNOWN_COST` blocked by default.
- No silent free -> paid fallback. `requiresApproval` is a hard boolean.
- BUILD defaults to human-in-the-loop. `--auto` is explicit per-run opt-in and
  stays bounded by every hard limit.
- `media.enabled = false`. Media generation is fully implemented but gated:
  the router, adapter, UI, download, retry, and cancellation paths all exist
  and are exercised by 1085 tests, but the frozen default blocks every call
  until the human flips the toggle in Settings. No provider is registered by
  default; the user adds one (endpoint, model, API-key env name) explicitly.
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
`PREFERRED_FREE` / `spendBudgetUsd = 0` / `UNKNOWN_COST` blocking apply unchanged.
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
  egress allowlist, and it keeps stating that the budget and PREFERRED_FREE
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

## D22 - Local Desktop Package Foundation

The desktop is now buildable as a local dev artifact:

- `package.json` declares `electron` and `esbuild` dev dependencies.
- `npm run desktop:dist` bundles `desktop/src/main.ts` into `dist/desktop/main.mjs`
  and `preload.cjs` into `dist/desktop/preload.cjs`, then copies the renderer.
- `npm run desktop:dev` starts Electron on that bundle; `desktop:selftest`
  drives the existing headless self-test.
- Renderer remains static. Engine, provider, egress, and persistence paths are unchanged.
- First-run hint is a small inline reminder, not a wizard.

## D23 - First-run Onboarding Surface

Agent view shows a compact first-run card when no providers are registered.

- `Start offline` dismisses the card for the session.
- `Add provider` navigates to Settings and opens the existing add-provider modal.
- `Dismiss` hides the card in memory only; no new persistence or routes.

## D24 — Per-run Cost and Token Accounting

The Runs view now reports what each run actually cost and consumed. The engine
was already writing `UsageRecord`s with a `runId`, token counts, and a derived
cost — the UI simply never showed them.

- `DesktopFacade.getRunUsage(runId)` / `listRunUsage()` derive a per-run ledger
  from the usage store alone: invocation count, cost, prompt/completion tokens,
  failed invocations, and a per-model breakdown (most expensive first).
- One new read-only channel, `all-in-1:run:usage`, with the same string-arg
  guard as `run:get`: no argument lists every run, an id reports that run.
- The Runs table gained `Cost` and `Tokens` columns; the run detail gained an
  Accounting section with the per-model table.

Nothing is invented and nothing is rounded up:

- Cost comes only from the provider's own reported usage frame at the
  registered rate; unreported usage is exactly `$0` (the deterministic local
  models are genuinely zero-cost, and that is what the column shows).
- A run recorded but never billed shows an honest zero ledger; a run nobody
  recorded and nothing billed is `undefined`, not a plausible zero.
- Usage the engine could not attribute to a run (`runId: null`) is never
  silently assigned to one.
- Deleting a run record cannot hide what it cost — the derivation is from the
  usage store, so the spend remains visible.
- The derivation is strictly read-only: it records nothing and writes no file.

## D27 — Agent Runs Are Accounted and Visible

The agent path invoked the execution engine — committing real spend to the
budget ledger — but recorded neither a run record nor a usage record. Agent
runs were absent from the Runs view, and the usage totals silently excluded
spend the ledger had already charged, so the two could disagree. The workflow
path had been accounted since D24/D26; the agent path never was.

- `GatewayTurnResult` now carries what its invocation actually consumed, taken
  straight off the settled `ExecutionOutcome` (the same source the specialist
  runner uses): model, adapter, capability, the exact `committedUsd` the ledger
  was charged, latency, and token counts only when the provider emitted a usage
  frame.
- `AgentResult.accounting` reports one entry per turn THIS call settled, each
  carrying its absolute turn index — cumulative across a paused run's
  continuation calls.
- `DesktopFacade.runAgent` records the run (kind `agent`, labelled by the
  prompt it opened with) and writes one usage record per settled turn, indexed
  by that turn's position in the run. The Runs table distinguishes agent runs
  from workflow runs; the run detail reads `turns` instead of `iterations`.
- A continuation is only a continuation when the runtime still holds the
  conversation: a paused record that survived a restart is a new start, not a
  resume, and is accounted as one.

The same honesty rules as D24/D26 apply, unchanged:

- A turn that never settled an invocation (a refused gate, a mode violation, a
  cancellation) writes no record; its run reports a genuine zero ledger and the
  error stays on the run record.
- Cost is the same number the budget ledger already committed, so usage totals
  and the ledger cannot disagree; a paid agent turn charges the ledger exactly
  once, even across a pause and resume.

## D28 — Account a Settled Agent Turn the Gateway Reported as Failed or Empty

The engine commits a turn's cost to the budget ledger on ANY resolve —
including a result the provider returned as `ok:false` and a result with
neither text nor tool calls. The agent loop captured the accounting only
AFTER its ok/empty gate, so such a turn charged the ledger and was then
dropped before a `UsageRecord` was written: the usage totals silently excluded
spend the ledger had already charged, the exact invariant D27 exists to hold,
on a path D27 never covered. The workflow path always recorded these as
`outcome: failed`.

The fix is a statement move, not a new path: the turn's settlement is captured
before the gate decides its fate, so a charged turn always reaches the usage
store. The label follows the gateway's verdict through an optional
`AccountedTurn.failed` field, so the recording layer marks the record honestly
instead of assuming a settled turn succeeded. The field is optional, so every
existing producer of a plain `TurnSettlement` is unchanged.

Latent under the frozen defaults: both shipped adapters only ever resolve
`ok:true`, so no shipped path produced a charged failed turn — the defect was
one registered adapter away.

## D30 — Token Counts Ride on the Settled Result

`GatewayTurnResult` now carries what the invocation actually consumed — model,
adapter, capability, the exact `committedUsd` the ledger was charged, latency,
and token counts when the provider emitted a usage frame. A buffered turn is
now accounted as faithfully as a streamed one; before, only streamed turns
produced a `UsageRecord` with tokens.

## D31 — PREFERRED_FREE Policy Replaces FREE_ONLY

The frozen cost policy relaxes from `FREE_ONLY` to `PREFERRED_FREE`: paid models
are selectable with explicit approval, but the budget gate still refuses any
spend at zero budget. `UNKNOWN_COST` remains blocked by default. No silent
free → paid fallback.

## D32 — Provider-Gateway Tools Gate Forwards the Actual Requirement

The gateway was hardcoding `tools:true` when asking the provider for available
tools, so a compare slot running a tool-less model like `local/deterministic`
in INSPECT mode was incorrectly rejected. The fix forwards the real tools
requirement from the selection context instead.

## D33 — The Compare Path

`runMany` runs one fully-gated agent run per selected model, deduplicates
repeats, isolates slot failures, and carries both the requested and executed
model so substitutions are flagged and never silent. `getCompareProgress` polls
per-slot status without re-issuing the whole request.

## D34 — The Collaborate Path

`CollaborateOrchestrator` runs independent, fully-gated specialist runs in
parallel/sequential/debate, with optional synthesis and disagreement detection.
`getCollabProgress` maps live stream frames back to declared participants.

## D35 — Artifacts, Compare Progress, and Run Management

Three surface additions, all driven by the desktop facade without a window:

- **Artifacts**: `uploadFile` persists bytes under a content-addressed id;
  `getArtifact` reads bytes by id with path-traversal rejection;
  `downloadArtifact` returns the on-disk path plus payload;
  `analyzeImage` and `analyzeFile` route through the vision/text adapters.
- **Compare progress**: `getCompareProgress` labels each slot by the model it
  asked for, aggregates slot outcomes into a batch status, and keeps concurrent
  slots isolated — a poll on one slot never sees another's frames.
- **Run management**: `renameRun` sets a cosmetic display name without changing
  identity; `removeRun` deletes the record but leaves artifacts and accounting
  alone; `searchRuns` matches subject or name case-insensitively.

## D36 — Model Combobox Redesign (B2)

The native `<select>` is replaced by a professional keyboard-navigable
combobox without touching IPC or the backend:

- Arrow↑↓ / Enter / Escape navigation with correct ARIA roles.
- Fast search + cost filter (ALL / Free / Paid).
- Clear grouping: remote providers vs. local test models.
- "Deterministic" badge for local/agent models — honest about what it is.
- Loading / empty / error / "no providers connected" states shown distinctly.
- Hidden `#model-select` input preserved so the existing execution path reads
  the same value as before.
- RTL / light / dark / system themes untouched; responsive layout verified.

## D37 — UI Integration Tests (B2)

Source-level and DOM-structure tests that cover the renderer's behaviour
without depending on an actual Electron window:

- View navigation toggles `.active` / `aria-current` across all views.
- Welcome screen renders hero card + four suggestion buttons.
- Transcript rendering handles null, uploaded, generated, history, and
  substitution-warning cases.
- Mode controls flip `aria-pressed` correctly.
- Theme switching writes `data-theme` and flips button states.
- Language switching swaps `data-dir` (ltr/rtl), `lang`, and `[data-en]` text.
- Approvals badge stays in sync with pending count.
- First-run card shows/hides based on provider presence.
- Compare checkboxes preserve checked state across reloads.
- Artifact view renders empty-state or one card per artifact.
- Source invariants: no import/require/export in renderer; every module
  exposes the expected globals; HTML landmarks carry aria-labels; the
  combobox uses `role="combobox"` with `aria-controls`.

## D39 — UI Redesign: Reference-Image Visual Overhaul

The user supplied a reference image of a polished AI chat interface and asked
for the desktop app to match it. This is a visual redesign, not a behaviour
change — every existing function, bridge channel, and safety property is
untouched.

- **Design tokens**: `--surface-0` moved from solid `#f7f8fa` to a soft
  gradient (`--gradient-bg`); accent moved from warm orange to cool blue
  `#2f6fd0`. Both palettes define the gradient, so dark keeps a neutral
  blue-black ground.
- **Icon-only sidebar**: all ten nav items now carry SVG icons with `title`
  tooltips; text labels collapse below 1100px. The `data-view` attributes are
  unchanged, so `showView()` keeps working without modification.
- **Chat history panel** (new): a 300px panel between sidebar and main content
  with a search bar, a "+ New Chat" button, and a dynamically rendered list of
  conversations. Hidden below 1100px. Wired through `renderChatHistory()` in
  renderer.js; state lives on `state.chatHistory` / `chatHistoryActive` /
  `chatHistorySearch` in state.js.
- **Welcome screen**: the text "AI1" hero is replaced by a CSS 3D sphere
  (solid accent + inset shadow + specular highlight) and four quick-action
  cards — Generate Image, Video Generate, Improve Prompt, Dashboard Design.
  Each card fills the prompt and focuses the textarea (or clicks the generate
  button for the image card). `renderWelcome()` builds them via `h()`.
- **Composer**: the input area is now a rounded card with a tool row
  (attach, tools toggle, PRO badge) above the action bar (generate, mic,
  send, stop). The duplicate `<select id="exec-type">` was removed.
- **Tests**: `d6-ui.test.ts` was updated to allow the background gradient
  token while still banning chrome effects (blur/glow) outside the token layer;
  `d37-ui-integration.test.ts` was updated for the new welcome markup.
  All 1085 tests pass, TypeScript is clean, and the desktop build succeeds.

### D39b — Four Defect Fixes in the Redesigned Surface

Four bugs were found in the redesigned renderer after the visual pass, each
with a regression test:

- **Compare poll cursor no-op** (`renderer.js`): the per-slot cursor update
  wrote `batch.cursors[sr] = (batch.cursors[sr] || 0)`, which assigns each
  cursor its own current value — the poll made no progress at all. The block
  was dead code; it is removed, and slots whose outcome is already settled are
  skipped rather than re-polled.
- **i18n lag on dynamically created elements** (`i18n.js`): `setLanguage`
  swept the DOM once, so elements inserted afterwards (welcome cards, chat
  history items) kept the previous language. A `MutationObserver` on
  `document.body` now applies the label to each inserted element and its
  `[data-en]` descendants, and `all-in-1:languagechange` lets the view
  re-render on switch.
- **Media cancel before the signal existed** (`desktop-stack.ts`): the
  per-run `AbortController` is created lazily by `signalFor`, so a cancel that
  arrived first returned `false` and the generation started with a live
  signal — the human's Cancel was dropped. A pending-intent set records the
  cancel; the controller is aborted the moment it is created.
- **Compare slot label fallback** (`facade.ts`): `r.model ?? r.subject`
  rendered the literal string `"undefined"` when a record had neither field.
  The fallback is now `r.model ?? (r.subject ? r.subject : "—")`.

### D39c — The Desktop Typecheck Is Clean

`npx tsc --noEmit -p desktop` used to report 19 errors. They were not
pre-existing in the sense of "untouched by anyone" — they were real drift
between the desktop boundary and the core it consumed:

- `facade.ts` re-declared `CollaborateRequest` / `CollaborateResult` with a
  looser `role: string` and no `accounting` field, while the orchestrator in
  `src/collab/types.ts` typed `role: ModelRole` and carried
  `SpecialistAccounting`. The desktop copy is now a re-export of the core
  type — the boundary is a consumer, not an owner, of the collaborate shape.
- `ipc-requests.ts` built its return value through a `readonly`-typed
  placeholder and then mutated it, which is what `TS2540` is for. Both builders
  now use a mutable local, validate into it, and cast only at the return — a
  rejected field can never be left half-set.
- Two test assertions dereferenced `r.text` / `sibling.text` without guarding
  for the optional the type already declared. They now use `!.length`.

Desktop typecheck is now clean alongside the root one. All 1085 tests pass.

### D39d — Dead Code Removed

Two functions were defined and never called. They were not public API — no
module imports them, not even the renderer that owns `components.js`:

- `RunStatePill` in `components.js`: rendered a run-status badge. Nothing in
  the app renders a per-run pill; the runs view uses its own rows.
- `readStrict()` in `json-store.ts`: a strict variant of `read()` that throws
  on corrupt JSON. Nothing calls it; the store uses `read()` everywhere.

A stray empty file named `0` (0 bytes, sitting at the repo root) was also
removed. It was never referenced by any source, config, or build step.

## D38 — Media Generation and First-Run Card Tests (B2)

Source-level and DOM-structure tests that cover the two remaining renderer
features without depending on an actual Electron window:

- **Media generation modal**: `composer-generate` wires to `openGenerateModal`;
  the modal body contains a prompt textarea, capability select (TEXT_TO_IMAGE /
  IMAGE_TO_IMAGE / IMAGE_EDIT / IMAGE_UPSCALE), resolution select, aspect-ratio
  select, optional seed input, status div, and confirm/cancel buttons.
- **Generate handler**: each artifact is rendered as a transcript entry with
  `kind: "generated"`; warnings surface via toast; the MEDIA_DISABLED gate
  produces a distinct user message; cancelled requests show "Generation
  cancelled".
- **Cancel flow**: the in-flight cancel button is disabled until the call
  starts and calls `api.cancelMedia(runId)` on click.
- **First-run card**: present in the markup with three action buttons
  (Start offline / Add provider / Dismiss); `updateFirstRunCard` hides it
  when `settings.providers` is non-empty and shows it when empty; dismiss,
  local, and provider buttons all set `state.firstRunDismissed = true` and
  hide the card; the provider button navigates to settings and auto-clicks
  the add-provider affordance.

## D29 — The Diagnostic Stream Seam Was Never Connected

D16 added `streaming` and `runId` to `DiagnosticRequest` and wired the
main-process bridge. D17 hardened it. D18 built the renderer that polls it —
and the one IPC handler between them forwarded neither field, so the whole
chain was inert: `facade.runDiagnostic` always saw `streaming === undefined`,
`workflowStreamBridge.start()` never ran, and the "stream events" checkbox
polled a bridge key that could not exist. The D18 test was pure string
matching, so it passed while the feature was dead. The renderer's stable
`runId` — the only input D26's resume contract can act on — was also dropped,
so the resume path was unreachable from the desktop too.

The mapping, not the registration, is the seam. It is extracted into
`desktop/src/ipc-requests.ts` (`buildDiagnosticRequest`) — pure, throwing on
invalid input exactly as the inline handler did — so main.ts stays a thin
registration layer and the boundary is exercised in CI without a window:
`runId` and `streaming` now reach the facade, and only an explicit `true` opts
into streaming (never defaulted).

The unmasking this fix reveals is also closed: now that the renderer's `runId`
lands, its sticky `diagRunId` would otherwise reuse a COMPLETED run's id, so
the next run starts on a used key — usage records append under colliding ids
while the run record is replaced, and one Runs row silently reports two runs'
spend. The id is retained only while the run is still resumable
(`pausedForHuman`), which is what reuse exists for under D26.


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
