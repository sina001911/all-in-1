/**
 * Deterministic in-memory browser engine used by tests. It never launches a
 * process, never touches the network, and still enforces the host policy —
 * so security behaviour can be unit-tested without Playwright installed.
 */
import { AllInOneError } from "../errors.ts";
import { assertHostAllowed } from "../safety/hosts.ts";
import type {
  BrowserEngine,
  BrowserEngineOptions,
  OpenedPage,
  ScreenshotRequest,
  ScreenshotResult,
  Viewport,
} from "./types.ts";

const FAKE_VIEWPORT: Viewport = { width: 1280, height: 720 };

export class FakeBrowserEngine implements BrowserEngine {
  readonly id = "fake";
  readonly browserType = "chromium" as const;
  private pagesOpen = 0;
  private closed = false;
  private readonly opts: BrowserEngineOptions;
  readonly navigations: string[] = [];
  /** Set this to make `open` fail after the host check, simulating a crash. */
  failNavigation = false;

  constructor(opts: BrowserEngineOptions) {
    this.opts = opts;
  }

  isActive(): boolean {
    return this.pagesOpen > 0 && !this.closed;
  }

  async open(req: ScreenshotRequest): Promise<OpenedPage> {
    if (this.closed) throw new AllInOneError("engine closed", "PAGE_CLOSED", "browser");
    assertHostAllowed(req.url, this.opts.hostPolicy, this.opts.allowlist);
    this.navigations.push(req.url);
    if (this.failNavigation) {
      throw new AllInOneError("net::ERR_FAILED", "NAVIGATION_FAILED", "browser", {
        retryable: true,
      });
    }
    this.pagesOpen += 1;
    return {
      resolvedHost: hostOf(req.url),
      url: req.url,
      title: async () => "Fake Page",
      content: async () => `<html><body>fake</body></html>`,
      screenshot: async () => fakePng(req.url),
      close: async () => {
        this.pagesOpen = Math.max(0, this.pagesOpen - 1);
      },
    };
  }

  async capture(page: OpenedPage): Promise<ScreenshotResult> {
    return {
      bytes: await page.screenshot({}),
      contentType: "image/png",
      viewport: FAKE_VIEWPORT,
      url: page.url,
      title: await page.title(),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.pagesOpen = 0;
  }
}

/** A tiny valid PNG (1x1) whose content depends on the url — deterministic. */
export function fakePng(url: string): Uint8Array {
  const seed = [...url].reduce((a, c) => (a + c.charCodeAt(0)) % 0xffff, 7);
  const header = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, seed & 0xff, 0x00, 0x01, 0x00,
    0x05, 0xfe, 0x02, 0xfe, 0xdc, 0xcc, 0x59, 0xe7,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
    0xae, 0x42, 0x60, 0x82,
  ];
  return new Uint8Array(header);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
