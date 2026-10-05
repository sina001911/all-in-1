/**
 * Layered config loader: defaults -> global visual.json -> project
 * .opencode/visual.json -> CLI flags -> per-call overrides.
 *
 * P1 resolves defaults plus any *existing* files it finds. It never creates,
 * writes, or modifies a config file. Unknown keys are ignored rather than
 * fatal, and frozen fields (mainCoder, media.enabled, spendBudgetUsd) are
 * re-clamped to their frozen values after merging.
 */
import { FROZEN_DEFAULTS, type VisualConfig } from "./schema.ts";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function tryReadJson(path: string): Record<string, unknown> | undefined {
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface LoadOptions {
  readonly globalConfigPath?: string;
  readonly projectConfigPath?: string;
  readonly overrides?: Record<string, unknown>;
}

export function loadConfig(opts: LoadOptions = {}): VisualConfig {
  const merged: Record<string, unknown> = structuredClone(
    FROZEN_DEFAULTS as unknown as Record<string, unknown>,
  );

  const layers = [
    opts.globalConfigPath ? tryReadJson(opts.globalConfigPath) : undefined,
    opts.projectConfigPath ? tryReadJson(opts.projectConfigPath) : undefined,
    opts.overrides,
  ];

  for (const layer of layers) {
    if (!layer) continue;
    deepMerge(merged, layer);
  }

  const config = merged as unknown as VisualConfig;
  // Re-freeze the fields the baseline locks.
  const frozen: VisualConfig = {
    ...config,
    mainCoder: FROZEN_DEFAULTS.mainCoder,
    media: FROZEN_DEFAULTS.media,
    workflow: FROZEN_DEFAULTS.workflow,
    cost: { ...config.cost, spendBudgetUsd: 0 },
  };
  return frozen;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    if (!(key in target)) continue; // unknown keys are ignored, never fatal
    const sv = source[key];
    const tv = target[key];
    if (isObject(sv) && isObject(tv)) {
      deepMerge(tv, sv);
    } else if (sv !== undefined) {
      target[key] = sv;
    }
  }
}

export { FROZEN_DEFAULTS };
export { pathToFileURL };
