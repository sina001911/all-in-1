/**
 * Browser engine contract.
 *
 * The engine is the ONLY component permitted to launch a browser process. It
 * enforces the host policy itself: `open()` calls `assertHostAllowed` before
 * any navigation, so no caller can bypass the localhost-only boundary by
 * constructing a URL the guard would otherwise miss.
 *
 * Engines are created lazily and must be closed with `close()`. A `using`/
 * explicit-finally pattern in callers is expected.
 */
import type { HostPolicy } from "../safety/hosts.ts";

export const BROWSER_TYPES = ["chromium", "firefox", "webkit"] as const;
export type BrowserType = (typeof BROWSER_TYPES)[number];

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface NavigationOptions {
  /** Hard cap on network idle / load wait, in milliseconds. */
  readonly timeoutMs?: number;
  /** Selector to wait for before capturing (deterministic readiness). */
  readonly waitForSelector?: string;
  readonly waitUntil?: "load" | "domcontentloaded" | "networkidle";
}

export interface ScreenshotRequest {
  readonly url: string;
  readonly viewport?: Viewport;
  readonly fullPage?: boolean;
  readonly navigation?: NavigationOptions;
  /** Runs before the screenshot; used for deterministic state setup. */
  readonly setup?: (page: EnginePage) => Promise<void>;
}

export interface ScreenshotResult {
  readonly bytes: Uint8Array;
  readonly contentType: "image/png";
  readonly viewport: Viewport;
  readonly url: string;
  readonly title: string;
}

/** Minimal page surface the engine exposes to callers (incl. `setup` hooks). */
export interface EnginePage {
  readonly url: string;
  title(): Promise<string>;
  content(): Promise<string>;
  screenshot(opts: { fullPage?: boolean }): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface OpenedPage extends EnginePage {
  /** The host policy check that already passed for this page's url. */
  readonly resolvedHost: string;
}

export interface BrowserEngine {
  readonly id: string;
  readonly browserType: BrowserType;
  /** True once a browser process has been launched. */
  isActive(): boolean;
  open(req: ScreenshotRequest): Promise<OpenedPage>;
  capture(page: OpenedPage, fullPage: boolean): Promise<ScreenshotResult>;
  close(): Promise<void>;
}

export interface BrowserEngineOptions {
  readonly browserType?: BrowserType;
  /** Host policy enforced before every navigation. */
  readonly hostPolicy: HostPolicy;
  readonly allowlist?: readonly string[];
  /** Extra launch flags (e.g. sandbox). Passed through verbatim. */
  readonly launchArgs?: readonly string[];
  /** Headless defaults to true; set false only for debugging. */
  readonly headless?: boolean;
}
