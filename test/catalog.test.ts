/**
 * Model catalogue + priority chains suite (P3).
 *
 * The catalogue describes models; it never calls them. Candidates filtering
 * keeps paid models VISIBLE while policy blocks them, the MAIN_CODER `fixed`
 * flag mirrors the frozen immutability rule, and the snapshot is cached and
 * frozen so automatic routing is network-free and stable.
 */
import { describe, expect, it } from "vitest";
import { ModelCatalog } from "../src/models/catalog.ts";
import { PriorityChains } from "../src/models/priorities.ts";
import type { ModelDescriptor } from "../src/models/types.ts";

type DescriptorOverrides = Partial<ModelDescriptor> & { readonly id: string };

function mkModel(over: DescriptorOverrides): ModelDescriptor {
  const slash = over.id.indexOf("/");
  const provider = over.provider ?? over.id.slice(0, slash);
  const modelId = over.modelId ?? over.id.slice(slash + 1);
  return {
    id: over.id,
    provider,
    modelId,
    displayName: over.displayName ?? modelId,
    capabilities: over.capabilities ?? ["CODING"],
    inputModalities: over.inputModalities ?? ["TEXT"],
    outputModalities: over.outputModalities ?? ["TEXT"],
    contextLimit: over.contextLimit ?? 128000,
    outputLimit: over.outputLimit ?? 8192,
    tools: over.tools ?? false,
    structuredOutput: over.structuredOutput ?? true,
    streaming: over.streaming ?? true,
    pricing: over.pricing ?? { costClass: "FREE" },
    available: over.available ?? true,
    locality: over.locality ?? "remote",
    status: over.status ?? "active",
    providerAdapter: over.providerAdapter ?? `${provider}-adapter`,
    priority: over.priority ?? 0,
    enabled: over.enabled ?? true,
    fixed: over.fixed,
    fallback: over.fallback,
  };
}

describe("ModelCatalog registration", () => {
  it("accepts a well-formed provider/model descriptor", () => {
    const catalog = new ModelCatalog();
    catalog.register(mkModel({ id: "acme/coder" }));
    expect(catalog.has("acme/coder")).toBe(true);
    expect(catalog.get("acme/coder")?.displayName).toBe("coder");
  });

  it("rejects an id that is not provider/model", () => {
    const catalog = new ModelCatalog();
    expect(() => catalog.register(mkModel({ id: "acme/coder", provider: "other" }))).toThrow(
      /must equal "provider\/model"/,
    );
  });

  it("rejects a duplicate id", () => {
    const catalog = new ModelCatalog();
    catalog.register(mkModel({ id: "acme/coder" }));
    expect(() => catalog.register(mkModel({ id: "acme/coder" }))).toThrow(/already registered/);
  });

  it("rejects negative context or output limits", () => {
    const catalog = new ModelCatalog();
    expect(() => catalog.register(mkModel({ id: "acme/coder", contextLimit: -1 }))).toThrow(
      /non-negative/,
    );
    expect(() => catalog.register(mkModel({ id: "acme/coder", outputLimit: -8 }))).toThrow(
      /non-negative/,
    );
  });

  it("getOrThrow fails loudly for an unknown model", () => {
    const catalog = new ModelCatalog();
    expect(() => catalog.getOrThrow("acme/nope")).toThrow(/not registered/);
  });
});

describe("ModelCatalog lookup", () => {
  function sample(): ModelCatalog {
    const catalog = new ModelCatalog();
    catalog.register(mkModel({ id: "acme/coder", capabilities: ["CODING", "DEBUGGING"] }));
    catalog.register(mkModel({ id: "acme/eyes", capabilities: ["VISION"] }));
    catalog.register(mkModel({ id: "beta/coder", capabilities: ["CODING"] }));
    return catalog;
  }

  it("byProvider returns only that provider's models", () => {
    const catalog = sample();
    expect(catalog.byProvider("acme").map((m) => m.id)).toEqual(["acme/coder", "acme/eyes"]);
    expect(catalog.byProvider("gamma")).toEqual([]);
  });

  it("byCapability returns models declaring the capability", () => {
    const catalog = sample();
    expect(catalog.byCapability("CODING").map((m) => m.id)).toEqual(["acme/coder", "beta/coder"]);
    expect(catalog.byCapability("VISION").map((m) => m.id)).toEqual(["acme/eyes"]);
  });
});

describe("ModelCatalog candidatesFor", () => {
  it("requires the capability to be declared", () => {
    const catalog = new ModelCatalog();
    catalog.register(mkModel({ id: "acme/coder", capabilities: ["CODING"] }));
    catalog.register(mkModel({ id: "acme/eyes", capabilities: ["VISION"] }));
    expect(catalog.candidatesFor("CODING").map((m) => m.id)).toEqual(["acme/coder"]);
  });

  it("excludes disabled models", () => {
    const catalog = new ModelCatalog();
    catalog.register(mkModel({ id: "acme/off", capabilities: ["CODING"], enabled: false }));
    catalog.register(mkModel({ id: "acme/on", capabilities: ["CODING"] }));
    expect(catalog.candidatesFor("CODING").map((m) => m.id)).toEqual(["acme/on"]);
  });

  it("excludes unavailable models", () => {
    const catalog = new ModelCatalog();
    catalog.register(mkModel({ id: "acme/down", capabilities: ["CODING"], available: false }));
    catalog.register(mkModel({ id: "acme/up", capabilities: ["CODING"] }));
    expect(catalog.candidatesFor("CODING").map((m) => m.id)).toEqual(["acme/up"]);
  });

  it("excludes fixed models, mirroring the MAIN_CODER immutability rule", () => {
    const catalog = new ModelCatalog();
    catalog.register(mkModel({ id: "atria/s1", capabilities: ["CODING"], fixed: true }));
    catalog.register(mkModel({ id: "acme/coder", capabilities: ["CODING"] }));
    expect(catalog.candidatesFor("CODING").map((m) => m.id)).toEqual(["acme/coder"]);
  });

  it("excludes deprecated and disabled-status models but keeps beta", () => {
    const catalog = new ModelCatalog();
    catalog.register(mkModel({ id: "acme/old", capabilities: ["CODING"], status: "deprecated" }));
    catalog.register(mkModel({ id: "acme/off", capabilities: ["CODING"], status: "disabled" }));
    catalog.register(mkModel({ id: "acme/new", capabilities: ["CODING"], status: "beta" }));
    expect(catalog.candidatesFor("CODING").map((m) => m.id)).toEqual(["acme/new"]);
  });

  it("keeps paid models visible even though policy blocks them", () => {
    const catalog = new ModelCatalog();
    catalog.register(
      mkModel({ id: "acme/pro", capabilities: ["CODING"], pricing: { costClass: "PAID" } }),
    );
    expect(catalog.candidatesFor("CODING").map((m) => m.id)).toEqual(["acme/pro"]);
  });

  it("preserves registration order; ordering is the chains layer's job", () => {
    const catalog = new ModelCatalog();
    catalog.register(mkModel({ id: "acme/low", capabilities: ["CODING"], priority: 1 }));
    catalog.register(mkModel({ id: "acme/high", capabilities: ["CODING"], priority: 9 }));
    expect(catalog.candidatesFor("CODING").map((m) => m.id)).toEqual(["acme/low", "acme/high"]);
  });
});

describe("ModelCatalog snapshot + stats", () => {
  it("returns a frozen, cached snapshot", () => {
    const catalog = new ModelCatalog();
    catalog.register(mkModel({ id: "acme/coder" }));
    const a = catalog.snapshot();
    const b = catalog.snapshot();
    expect(Object.isFrozen(a)).toBe(true);
    expect(a).toBe(b);
  });

  it("invalidates the cache on registration", () => {
    const catalog = new ModelCatalog();
    catalog.register(mkModel({ id: "acme/coder" }));
    const before = catalog.snapshot();
    catalog.register(mkModel({ id: "acme/eyes", capabilities: ["VISION"] }));
    expect(catalog.snapshot()).not.toBe(before);
    expect(catalog.list()).toHaveLength(2);
  });

  it("summarizes enabled/selectable/fixed and breakdowns", () => {
    const catalog = new ModelCatalog();
    catalog.register(mkModel({ id: "atria/s1", fixed: true }));
    catalog.register(mkModel({ id: "acme/coder" }));
    catalog.register(
      mkModel({ id: "acme/pro", pricing: { costClass: "PAID" }, locality: "local" }),
    );
    catalog.register(mkModel({ id: "acme/off", enabled: false }));
    const stats = catalog.stats();
    expect(stats.total).toBe(4);
    expect(stats.enabled).toBe(3);
    expect(stats.fixed).toBe(1);
    expect(stats.selectable).toBe(2);
    expect(stats.byCostClass).toEqual({ FREE: 3, PAID: 1 });
    expect(stats.byLocality).toEqual({ remote: 3, local: 1 });
  });
});

describe("PriorityChains", () => {
  function sample(): ModelCatalog {
    const catalog = new ModelCatalog();
    catalog.register(mkModel({ id: "acme/low", capabilities: ["CODING"], priority: 1 }));
    catalog.register(mkModel({ id: "acme/high", capabilities: ["CODING"], priority: 9 }));
    catalog.register(mkModel({ id: "beta/mid", capabilities: ["CODING"], priority: 5 }));
    catalog.register(mkModel({ id: "acme/eyes", capabilities: ["VISION"], priority: 0 }));
    return catalog;
  }

  it("defaults to priority desc, then id asc", () => {
    const chains = new PriorityChains(sample());
    expect(chains.get("CODING")).toEqual(["acme/high", "beta/mid", "acme/low"]);
  });

  it("is deterministic across calls", () => {
    const chains = new PriorityChains(sample());
    expect(chains.get("CODING")).toEqual(chains.get("CODING"));
  });

  it("set does not mutate the catalogue's own data", () => {
    const catalog = sample();
    const chains = new PriorityChains(catalog);
    chains.set("CODING", ["acme/low"]);
    // The override lives in the chains instance; a fresh chain still sees the
    // catalogue default, so the catalogue itself is untouched.
    expect(new PriorityChains(catalog).get("CODING")).toEqual([
      "acme/high",
      "beta/mid",
      "acme/low",
    ]);
  });

  it("set replaces the chain and is reflected in rankOf", () => {
    const chains = new PriorityChains(sample());
    chains.set("CODING", ["acme/low", "beta/mid"]);
    expect(chains.get("CODING")).toEqual(["acme/low", "beta/mid"]);
    expect(chains.rankOf("CODING", "acme/low")).toBe(0);
    expect(chains.rankOf("CODING", "acme/high")).toBeNull();
    expect(chains.hasOverride("CODING")).toBe(true);
  });

  it("rejects duplicate ids in a chain", () => {
    const chains = new PriorityChains(sample());
    expect(() => chains.set("CODING", ["acme/low", "acme/low"])).toThrow(/duplicate model ids/);
  });

  it("promote moves a model to the head without losing the rest", () => {
    const chains = new PriorityChains(sample());
    chains.promote("CODING", "acme/low");
    expect(chains.get("CODING")).toEqual(["acme/low", "acme/high", "beta/mid"]);
  });

  it("promote of an absent model still inserts it at the head", () => {
    const chains = new PriorityChains(sample());
    chains.promote("CODING", "acme/eyes");
    expect(chains.get("CODING")[0]).toBe("acme/eyes");
  });

  it("clear restores the catalogue default", () => {
    const chains = new PriorityChains(sample());
    chains.set("CODING", ["acme/low"]);
    chains.clear("CODING");
    expect(chains.get("CODING")).toEqual(["acme/high", "beta/mid", "acme/low"]);
    expect(chains.hasOverride("CODING")).toBe(false);
  });

  it("requires a capability name", () => {
    const chains = new PriorityChains(sample());
    expect(() => chains.set("", ["acme/low"])).toThrow(/capability required/);
  });

  it("list reports every capability and flags overrides", () => {
    const chains = new PriorityChains(sample());
    chains.set("CODING", ["acme/low"]);
    const entries = chains.list();
    const coding = entries.find((e) => e.capability === "CODING");
    const vision = entries.find((e) => e.capability === "VISION");
    expect(coding?.overridden).toBe(true);
    expect(coding?.chain).toEqual(["acme/low"]);
    expect(vision?.overridden).toBe(false);
    expect(vision?.chain).toEqual(["acme/eyes"]);
  });
});
