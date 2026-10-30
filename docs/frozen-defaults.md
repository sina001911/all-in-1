# Frozen Defaults (accepted baseline)

These are the accepted, non-negotiable defaults. They are enforced by tests,
not by convention.

| # | Frozen default | Enforcement |
|---|---|---|
| 1 | Atria-Dawn-Preview / `s1` = immutable MAIN_CODER, final decision-maker | `resolve("MAIN_CODER")` throws `RoleNotRoutableError`; model marked `fixed`, excluded from candidates |
| 2 | `spendBudgetUsd` = `0` | `FROZEN_DEFAULTS.cost.spendBudgetUsd` and re-clamped after any config merge |
| 3 | `PREFERRED_FREE` default policy | `DEFAULT_COST_POLICY`; role defaults in `ROLE_DEFINITIONS`. Paid models are selectable with explicit approval, but the budget gate still refuses any spend at zero budget. `UNKNOWN_COST` remains blocked by default. |
| 4 | `UNKNOWN_COST` blocked by default | `isEffectivelyFree()` — unknown is never free; router throws `UNKNOWN_COST_BLOCKED` without approval |
| 5 | No silent free → paid fallback | `requiresApproval` is a hard boolean; unapproved paid use throws `PAID_FALLBACK_NOT_APPROVED` / `FREE_UNAVAILABLE` |
| 6 | BUILD defaults to human-in-the-loop | `MODE_PERMISSIONS`; every edit requires approval |
| 7 | `--auto` = explicit per-run opt-in, bounded | `DEFAULT_AUTO_OPTIONS.auto: false`; `assertAutoBounds` enforces `maxIterations: 5`, `maxEdits: 20`, `dryRunFirst: true` |
| 8 | Media disabled in MVP | `media.enabled: false`; `mediaGate.guard()` throws `MEDIA_DISABLED` for every capability |
| 9 | Media is fully implemented but inert | `src/media/adapter.ts` + `router.ts` carry the real OpenAI-compatible call path (request build, response parse, retry, cancellation, artifact storage, budget reserve/commit); 1085 tests exercise it with a fake transport — no socket, no credential, no paid request is ever sent |
| 10 | No real paid image/video generation in MVP | no media provider registered by default; the frozen budget is 0 (treated as "no budget configured" for media, so cost is not an obstacle); the human must flip the Settings toggle AND register a provider AND set a non-zero budget before any call can reach the network |
| 11 | P1 = provider reconnaissance only | `docs/reconnaissance.md` records candidates; nothing enabled, purchased, installed, or used |
| 12 | Globally reusable, repo-independent | one global package; `generic` adapter fallback means no project is ever unsupported |
| 13 | No changes of any kind without approval | P1 footprint is one self-contained directory; `opencode.jsonc` untouched (SHA-256 verified) |
