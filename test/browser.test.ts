/**
 * Browser engine security + contract suite. Uses the deterministic fake engine
 * so host-policy enforcement is verified without launching a browser.
 */
import { describe, expect, it } from "vitest";
import { FakeBrowserEngine } from "../src/browser/fake-engine.ts";
import { PlaywrightEngine } from "../src/browser/playwright-adapter.ts";
import type { PlaywrightModule } from "../src/browser/playwright-adapter.ts";
import { AllInOneError } from "../src/errors.ts";
import { HostPolicyViolationError } from "../src/safety/hosts.ts";

const LOCAL = ["http://localhost:5173/", "http://127.0.0.1:5173/", "http://[::1]:5173/"];
const REMOTE = [
  "https://example.com/",
  "http://93.184.216.34/",
  "https://internal.corp.local/",
];

describe("host policy is enforced inside the engine", () => {
  for (const url of LOCAL) {
    it(`allows ${url} under localhost-only`, async () => {
      const engine = new FakeBrowserEngine({ hostPolicy: "localhost-only" });
      const page = await engine.open({ url });
      expect(page.resolvedHost).toBeTruthy();
      await engine.close();
    });
  }

  for (const url of REMOTE) {
    it(`blocks ${url} under localhost-only`, async () => {
      const engine = new FakeBrowserEngine({ hostPolicy: "localhost-only" });
      try {
        await engine.open({ url });
        throw new Error("should have blocked");
      } catch (e) {
        expect(e).toBeInstanceOf(HostPolicyViolationError);
      }
      // No page was ever created.
      expect(engine.navigations).not.toContain(url);
      await engine.close();
    });
  }

  it("honours an explicit allowlist in addition to loopback", async () => {
    const engine = new FakeBrowserEngine({
      hostPolicy: "allowlist",
      allowlist: ["example.com"],
    });
    await expect(
      engine.open({ url: "https://example.com/" }),
    ).resolves.toBeTruthy();
    await expect(
      engine.open({ url: "https://other.com/" }),
    ).rejects.toBeInstanceOf(HostPolicyViolationError);
    await engine.close();
  });
});

describe("typed failure model", () => {
  it("maps navigation failures to NAVIGATION_FAILED with retryable=true", async () => {
    const engine = new FakeBrowserEngine({ hostPolicy: "localhost-only" });
    engine.failNavigation = true;
    try {
      await engine.open({ url: "http://localhost:5173/" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AllInOneError);
      expect((e as AllInOneError).code).toBe("NAVIGATION_FAILED");
      expect((e as AllInOneError).category).toBe("browser");
      expect((e as AllInOneError).retryable).toBe(true);
    }
    await engine.close();
  });

  it("reports BROWSER_UNAVAILABLE when Playwright cannot be resolved", async () => {
    // Simulates a production install that omits Playwright: the dynamic import
    // rejects, and the engine must degrade to a typed error rather than an
    // unstructured module-resolution crash.
    class NoPlaywrightEngine extends PlaywrightEngine {
      protected resolveModule(): Promise<PlaywrightModule> {
        return Promise.reject(new Error("Cannot find module 'playwright'"));
      }
    }
    const engine = new NoPlaywrightEngine({ hostPolicy: "localhost-only" });
    await expect(engine.open({ url: "http://localhost:5173/" })).rejects.toMatchObject({
      code: "BROWSER_UNAVAILABLE",
      category: "unavailable",
      retryable: false,
    });
  });

  it("maps a browser launch failure to BROWSER_LAUNCH_FAILED", async () => {
    class BrokenLaunchEngine extends PlaywrightEngine {
      protected resolveModule(): Promise<PlaywrightModule> {
        return Promise.resolve({
          chromium: {
            launch: async () => {
              throw new Error("Executable doesn't exist");
            },
          },
        });
      }
    }
    const engine = new BrokenLaunchEngine({ hostPolicy: "localhost-only" });
    await expect(engine.open({ url: "http://localhost:5173/" })).rejects.toMatchObject({
      code: "BROWSER_LAUNCH_FAILED",
      category: "browser",
    });
  });

  it("does not even attempt navigation when the host is blocked", async () => {
    const engine = new PlaywrightEngine({ hostPolicy: "localhost-only" });
    await expect(
      engine.open({ url: "https://example.com/" }),
    ).rejects.toBeInstanceOf(HostPolicyViolationError);
  });
});
