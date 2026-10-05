/**
 * Config suite: layered resolution, unknown keys ignored, frozen fields
 * re-clamped after merge (mainCoder, media.enabled, workflow, budget).
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/index.ts";
import { FROZEN_DEFAULTS } from "../src/config/schema.ts";

describe("config layering", () => {
  it("returns frozen defaults when no layers are supplied", () => {
    const config = loadConfig();
    expect(config).toEqual(FROZEN_DEFAULTS);
  });

  it("ignores unreadable/missing config files rather than failing", () => {
    const config = loadConfig({
      globalConfigPath: "/nonexistent/global.json",
      projectConfigPath: "/nonexistent/project.json",
    });
    expect(config.cost.spendBudgetUsd).toBe(0);
  });

  it("merges known keys from project config", () => {
    const config = loadConfig({
      overrides: { browser: { hostPolicy: "allowlist" } },
    });
    expect(config.browser.hostPolicy).toBe("allowlist");
  });

  it("ignores unknown keys", () => {
    const config = loadConfig({ overrides: { bogusKey: { a: 1 } } });
    expect(config).toEqual(FROZEN_DEFAULTS);
  });

  it("re-clamps spendBudgetUsd to 0 even if a layer raises it", () => {
    const config = loadConfig({ overrides: { cost: { spendBudgetUsd: 100 } } });
    expect(config.cost.spendBudgetUsd).toBe(0);
  });

  it("never allows media to be enabled", () => {
    const config = loadConfig({ overrides: { media: { enabled: true } } });
    expect(config.media.enabled).toBe(false);
  });

  it("never allows --auto by default", () => {
    const config = loadConfig({ overrides: { workflow: { auto: { enabled: true } } } });
    expect(config.workflow.auto.enabled).toBe(false);
    expect(config.workflow.humanInTheLoop).toBe(true);
  });

  it("never allows the MAIN_CODER binding to change", () => {
    const config = loadConfig({
      overrides: { mainCoder: { provider: "other", model: "other", fixed: false } },
    });
    expect(config.mainCoder.provider).toBe("s1");
    expect(config.mainCoder.model).toBe("Atria-Dawn-Preview");
    expect(config.mainCoder.fixed).toBe(true);
  });
});
