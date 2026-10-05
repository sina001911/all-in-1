/**
 * User-controlled priority chains (P3).
 *
 * A chain is an ordered list of model ids for one capability, expressing the
 * user's preference, e.g.:
 *
 *   CODING: [ "atria/ModelB", "openrouter/coding", "local/llama-coder" ]
 *
 * Chains are *preferences, not authorizations*: they change the order in which
 * candidates are considered; every candidate must still pass capability
 * compatibility, provider isolation, cost policy, and budget. A chain entry
 * that is unknown, disabled, fixed, or policy-blocked is skipped and the
 * reason is recorded in the selection trace — it never forces an invalid model.
 *
 * Defaults are derived deterministically from the catalogue's own `priority`
 * field. Setting a chain overrides the default entirely.
 */
import type { ModelCatalog } from "./catalog.ts";

export class PriorityChains {
  private readonly catalog: ModelCatalog;
  private readonly overrides = new Map<string, string[]>();

  constructor(catalog: ModelCatalog) {
    this.catalog = catalog;
  }

  /**
   * The ordered id list for a capability: the user override if set, else the
   * deterministic catalogue default (priority desc, id asc).
   */
  get(capability: string): string[] {
    const override = this.overrides.get(capability);
    if (override) return [...override];
    return this.catalog
      .candidatesFor(capability)
      .slice()
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
      .map((m) => m.id);
  }

  /** Set (or replace) the user chain for a capability. */
  set(capability: string, modelIds: readonly string[]): void {
    if (!capability) throw new Error("capability required");
    const ids = [...modelIds];
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length) throw new Error(`duplicate model ids in chain for ${capability}: ${dupes.join(", ")}`);
    this.overrides.set(capability, ids);
  }

  /** Move a model to the head of a capability's chain, preserving the rest. */
  promote(capability: string, modelId: string): void {
    const current = this.get(capability).filter((id) => id !== modelId);
    this.set(capability, [modelId, ...current]);
  }

  /** Remove a user override, restoring the catalogue default. */
  clear(capability: string): void {
    this.overrides.delete(capability);
  }

  /** Position of a model in the chain (0 = first), or null if absent. */
  rankOf(capability: string, modelId: string): number | null {
    const chain = this.get(capability);
    const idx = chain.indexOf(modelId);
    return idx === -1 ? null : idx;
  }

  hasOverride(capability: string): boolean {
    return this.overrides.has(capability);
  }

  /** All chains, user-overridden ones flagged, for inspection/logging. */
  list(): ReadonlyArray<{
    readonly capability: string;
    readonly chain: readonly string[];
    readonly overridden: boolean;
  }> {
    const seen = new Set<string>();
    const out: Array<{ capability: string; chain: readonly string[]; overridden: boolean }> = [];
    for (const [capability, chain] of this.overrides) {
      seen.add(capability);
      out.push({ capability, chain, overridden: true });
    }
    const capabilities = new Set<string>();
    for (const model of this.catalog.list()) {
      for (const capability of model.capabilities) capabilities.add(capability);
    }
    for (const capability of [...capabilities].sort()) {
      if (seen.has(capability)) continue;
      out.push({ capability, chain: this.get(capability), overridden: false });
    }
    return out;
  }
}
