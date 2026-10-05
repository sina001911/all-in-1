# Architecture (P1)

## Four layers, four responsibilities

| Layer | Owns | Cannot do |
|---|---|---|
| **Engine** | rendering, capture, perception, registries, workflow, cost | decide, edit, spend past budget |
| **Specialists** | structured analysis (JSON in, JSON out — no `tools` field, by construction) | edit files, decide, call tools, bypass cost |
| **Atria** | orchestration, reasoning, interpretation, **final decision** | be rerouted, be replaced, bypass HITL |
| **OpenCode tools** | the **only** file writers (`write`/`edit`/`patch`) | be invoked by specialists or the engine |

P5 implements the **Specialists** row and the workflow column of the **Engine**
row for the first time (`src/specialists/`, `src/workflow/`) and confirms the
"cannot do" column holds under test: no specialist or workflow module imports a
filesystem API, no specialist can carry a tool surface, and every specialist call
still routes through the P4 engine — hence through every gate. See
[p5.md](./p5.md).

P6 binds the package into OpenCode as a real plugin (`src/plugin/`, backed by the
ambient SDK contract in `src/opencode-plugin.d.ts`) and closes the last open
guarantee in the table: the **OpenCode tools** row. The plugin registers commands
only — it registers no provider, model, tool, or integration, and it performs no
file write; an edit-capable plan can only be produced by BUILD, asserted through
the P6 edit boundary (`src/plugin/plan-gate.ts`) at the moment such a plan is
produced. Application of a plan stays with the human and the OpenCode
`write`/`edit`/`patch` tools. See [p6.md](./p6.md).

## Registries

- `ProviderRegistry` — provider metadata only: endpoint, protocol, `apiKeyEnv`
  (env-variable **name**, never a value), known endpoint issues.
- `ModelRegistry` — models keyed `provider/model`, tagged with roles, pricing,
  modalities, capabilities. `candidatesFor(role)` excludes `fixed` models, so
  `MAIN_CODER` is invisible to selection.
- `ModelRouter` — deterministic `resolve()`: pure function of
  (role, policy, budget, registry). No LLM, no network.
- `RoleRegistry` (`roles.ts`) — 14 roles; each declares `mayEditProject: false`
  and `mayDecide: false`.

## Frozen defaults

See [frozen-defaults.md](./frozen-defaults.md). Enforced by tests, not convention.

## Why there is no plugin-sdk dependency

The V2 plugin SDK is verified, and the verification is the reason the package is
a binding rather than a dependency. Re-checked at P6 against the current package,
`@opencode/plugin@2.0.22` on Node 24.21.0:

1. The documented package is `@opencode/plugin` (not the older
   `@opencode-ai/plugin@1.18.32` still present in the host's node_modules). Its
   root export is the V2 Promise API and does export `Plugin.define` — the P1
   finding that the root was V1-hooks-only was correct for the older package.
2. `@opencode/plugin@2.0.22` installs cleanly, but `tsc --noEmit --strict`
   against it still pulls in a transitive declaration gap:
   `@ai-sdk/provider/dist/index.d.ts` imports `json-schema`, which ships no
   types, so TS7016 is emitted. Closing that means patching a transitive package.
3. The package is not resolvable from this project's directory at all
   (`require.resolve` → `MODULE_NOT_FOUND` for the package and its subpaths); it
   is only resolvable from the OpenCode host's own node_modules. Depending on it
   means relying on parent-directory hoisting.

Both remaining blockers (2 and 3) conflict with the isolation requirement, so P6
binds the SDK instead of depending on it:

- `src/opencode-plugin.d.ts` declares an **ambient contract** for
  `@opencode/plugin` covering exactly the verified surface the plugin consumes
  (`Plugin.define`, `ctx.command.transform` + `CommandEditor.add`,
  `ctx.session.prompt`). Deep schema types are narrowed to the fields the plugin
  reads; the real types are supersets, so real runtime values stay assignable.
- `src/plugin/index.ts` holds the only **runtime** import. The OpenCode host
  supplies the module at load time — the normal plugin mechanism — so the import
  is genuine.
- `dependencies` stays empty, so the package still type-checks deterministically
  with no `node_modules` present, and `test/p6-plugin.test.ts` pins that only one
  module imports the SDK at runtime and that every other reference is
  `import type`.

The plugin is not auto-activated: loading it is a change to the *user's* OpenCode
configuration, never to this package's frozen defaults.

## Execution path (verified)

```
typecheck :  npx tsc --noEmit          # needs allowImportingTsExtensions + a tsconfig
test      :  npx vitest run            # vitest transforms .ts imports natively
cli       :  node src/cli.ts detect    # Node 24 native type-stripping
```

TypeScript is type-checking only: `noEmit: true`, no transpilation, no build step.

### Node strip-only constraint (verified)

`node src/cli.ts` uses Node 24's native type stripping, which rejects TS syntax
that needs code generation. Two rules apply to every source file:

- **No parameter properties** — `constructor(private x: T) {}` fails with
  `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. All constructors declare fields
  explicitly and assign in the body.
- **No `enum`** — use `as const` tuples plus derived union types (see
  `MODEL_ROLES`, `SAFETY_MODES`, `COST_POLICIES`).

Both are enforced structurally; vitest (which transforms) would not have caught
them, so the CLI smoke test is part of the verification path.
