/**
 * Playwright adapter for the browser engine.
 *
 * Isolation rules:
 * - Playwright is resolved LAZILY via a dynamic `import("playwright")`. The
 *   package declares no runtime dependency, so a production install that omits
 *   Playwright fails gracefully with a typed BROWSER_UNAVAILABLE error instead
 *   of a module-resolution crash at import time.
 * - The host policy is enforced before any `goto`, inside this adapter.
 * - No credentials, no extensions, no downloads; navigation targets are
 *   localhost-only by default policy.
 */
import {
  AllInOneError,
  toAllInOneError,
} from "../errors.ts";
import { assertHostAllowed } from "../safety/hosts.ts";
import type { BrowserType } from "./types.ts";
import type {
  BrowserEngine,
  BrowserEngineOptions,
  OpenedPage,
  ScreenshotRequest,
  ScreenshotResult,
  Viewport,
} from "./types.ts";

const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 720 };
const DEFAULT_TIMEOUT_MS = 15_000;

// A tiny structural view of the Playwright surface we use. Kept structural on
// purpose: we never import Playwright types at compile time, which keeps the
// zero-runtime-dependency type-check path working whether or not Playwright is
// installed.
interface PlaywrightBrowser {
  close(): Promise<void>;
  newPage(): Promise<PlaywrightPage>;
}
interface PlaywrightPage {
  goto(url: string, opts?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  title(): Promise<string>;
  content(): Promise<string>;
  screenshot(opts?: { fullPage?: boolean; type?: string }): Promise<Uint8Array>;
  setViewportSize(size: Viewport): Promise<void>;
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  close(): Promise<void>;
}
export interface PlaywrightModule {
  [browser: string]: { launch(opts?: { headless?: boolean; args?: readonly string[] }): Promise<PlaywrightBrowser> };
}

export class PlaywrightEngine implements BrowserEngine {
  readonly id = "playwright";
  readonly browserType: BrowserType;
  private readonly opts: Required<Omit<BrowserEngineOptions, "allowlist">> &
    Pick<BrowserEngineOptions, "allowlist">;
  private browser: PlaywrightBrowser | null = null;
  private launchPromise: Promise<PlaywrightBrowser> | null = null;

  constructor(opts: BrowserEngineOptions) {
    this.browserType = opts.browserType ?? "chromium";
    this.opts = {
      browserType: this.browserType,
      hostPolicy: opts.hostPolicy,
      allowlist: opts.allowlist,
      launchArgs: opts.launchArgs ?? [],
      headless: opts.headless ?? true,
    };
  }

  isActive(): boolean {
    return this.browser !== null;
  }

  async open(req: ScreenshotRequest): Promise<OpenedPage> {
    // Security boundary, enforced here so no caller can skip it.
    assertHostAllowed(req.url, this.opts.hostPolicy, this.opts.allowlist);

    const browser = await this.ensureBrowser();
    const page = await browser.newPage();
    const viewport = req.viewport ?? DEFAULT_VIEWPORT;
    await page.setViewportSize(viewport);

    try {
      await page.goto(req.url, {
        timeout: req.navigation?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        waitUntil: req.navigation?.waitUntil ?? "load",
      });
      if (req.navigation?.waitForSelector) {
        await page.waitForSelector(req.navigation.waitForSelector, {
          timeout: req.navigation?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
      }
      if (req.setup) await req.setup(page as never);
    } catch (e) {
      await page.close().catch(() => undefined);
      throw toAllInOneError(e, {
        code: "NAVIGATION_FAILED",
        category: "browser",
        message: `Navigation to ${req.url} failed: ${describe(e)}`,
      });
    }

    const url = req.url;
    const resolvedHost = hostOf(url);
    return {
      resolvedHost,
      url,
      title: () => page.title(),
      content: () => page.content(),
      screenshot: (o) => page.screenshot(o),
      close: () => page.close(),
    };
  }

  async capture(page: OpenedPage, fullPage: boolean): Promise<ScreenshotResult> {
    try {
      const bytes = await page.screenshot({ fullPage });
      return {
        bytes,
        contentType: "image/png",
        viewport: DEFAULT_VIEWPORT,
        url: page.url,
        title: await page.title(),
      };
    } catch (e) {
      throw toAllInOneError(e, {
        code: "SCREENSHOT_FAILED",
        category: "browser",
        message: `Screenshot of ${page.url} failed: ${describe(e)}`,
      });
    }
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.launchPromise = null;
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* already closed */
      }
    }
  }

  private async ensureBrowser(): Promise<PlaywrightBrowser> {
    if (this.browser) return this.browser;
    if (!this.launchPromise) {
      this.launchPromise = this.launch().catch((e) => {
        this.launchPromise = null;
        throw e;
      });
    }
    const browser = await this.launchPromise;
    this.browser = browser;
    return browser;
  }

  private async launch(): Promise<PlaywrightBrowser> {
    let pw: PlaywrightModule;
    try {
      // Dynamic specifier so the module is only resolved when a browser is
      // actually requested; the cast is deliberate (see the note above).
      pw = await this.resolveModule();
    } catch (e) {
      throw new AllInOneError(
        "Playwright is not installed. Install it as a dev dependency (`npm i -D playwright`) and run its browser install.",
        "BROWSER_UNAVAILABLE",
        "unavailable",
        { cause: e, retryable: false },
      );
    }
    const launcher = pw[this.browserType];
    if (!launcher) {
      throw new AllInOneError(
        `Unknown browser type: ${this.browserType}`,
        "BROWSER_LAUNCH_FAILED",
        "browser",
      );
    }
    try {
      return await launcher.launch({
        headless: this.opts.headless,
        args: this.opts.launchArgs,
      });
    } catch (e) {
      throw toAllInOneError(e, {
        code: "BROWSER_LAUNCH_FAILED",
        category: "browser",
        message: `Failed to launch ${this.browserType}: ${describe(e)}`,
      });
    }
  }

  /**
   * Resolves the Playwright module lazily. Extracted as a seam so tests can
   * simulate an environment where Playwright is absent, without installing or
   * uninstalling anything.
   */
  protected resolveModule(): Promise<PlaywrightModule> {
    return import("playwright") as unknown as Promise<PlaywrightModule>;
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
