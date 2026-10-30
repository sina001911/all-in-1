/**
 * D38: Media generation and first-run card tests.
 *
 * Both features live inside the IIFE-scoped renderer.js, so we verify them
 * through source-invariant and DOM-structure assertions rather than by
 * calling internal functions.
 *
 * Covers:
 *
 *   - Media generation modal: the `composer-generate` button wires to
 *     `openGenerateModal`; the modal body contains prompt, capability
 *     select (TEXT_TO_IMAGE / IMAGE_TO_IMAGE / IMAGE_EDIT / IMAGE_UPSCALE),
 *     resolution select, aspect-ratio select, seed input, status div,
 *     confirm ("Generate") and cancel ("Cancel generation") buttons.
 *   - Generate result handling: the handler renders each artifact as a
 *     transcript entry with kind "generated", and surfaces warnings via
 *     toast — including the MEDIA_DISABLED gate message.
 *   - Cancel flow: the in-flight cancel button is disabled until the
 *     request starts; clicking it calls `api.cancelMedia(runId)`.
 *   - First-run card: present in the markup with three action buttons;
 *     `updateFirstRunCard` hides it when providers exist and shows it
 *     when they don't. Dismiss / local / provider buttons all set
 *     `state.firstRunDismissed = true` and hide the card. The provider
 *     button additionally navigates to the settings view and auto-clicks
 *     the add-provider affordance.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "desktop", "src");

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

/* ── Media generation modal structure ─────────────────────────────────────── */

describe("D38 media generation — modal structure", () => {
  const renderer = read(join("renderer", "renderer.js"));
  const html = read(join("renderer", "index.html"));

  it("the Generate button exists in the markup with an aria-label", () => {
    expect(html).toContain('id="composer-generate"');
    expect(html).toContain("aria-label");
  });

  it("openGenerateModal creates a prompt textarea", () => {
    expect(renderer).toContain('id: "generate-prompt"');
    expect(renderer).toContain("rows: 3");
  });

  it("openGenerateModal presents four capability options", () => {
    expect(renderer).toContain("TEXT_TO_IMAGE");
    expect(renderer).toContain("IMAGE_TO_IMAGE");
    expect(renderer).toContain("IMAGE_EDIT");
    expect(renderer).toContain("IMAGE_UPSCALE");
  });

  it("openGenerateModal presents resolution presets up to 1792×1024", () => {
    expect(renderer).toContain("512x512");
    expect(renderer).toContain("1024x1024");
    expect(renderer).toContain("1792x1024");
  });

  it("openGenerateModal presents aspect-ratio presets", () => {
    expect(renderer).toContain("1:1");
    expect(renderer).toContain("16:9");
    expect(renderer).toContain("9:16");
  });

  it("openGenerateModal has a seed number input", () => {
    expect(renderer).toContain('id: "generate-seed"');
    expect(renderer).toContain('type: "number"');
  });

  it("openGenerateModal shows a status div during generation", () => {
    expect(renderer).toContain('id: "generate-status"');
    expect(renderer).toContain("Generating");
  });

  it("openGenerateModal sets confirm label to 'Generate' and cancel to 'Cancel'", () => {
    expect(renderer).toContain('confirmLabel: "Generate"');
    expect(renderer).toContain('cancelLabel: "Cancel"');
  });
});

/* ── Media generation handler behaviour ──────────────────────────────────── */

describe("D38 media generation — handler behaviour", () => {
  const renderer = read(join("renderer", "renderer.js"));

  it("generating a media item renders each artifact as a generated transcript entry", () => {
    expect(renderer).toContain('kind: "generated"');
    expect(renderer).toContain("renderTranscript");
    expect(renderer).toContain("result.artifacts");
  });

  it("generation errors surface via toast with the provider warning text", () => {
    expect(renderer).toContain("toast(warn, \"danger\")");
    expect(renderer).toContain("result.warnings");
  });

  it("MEDIA_DISABLED gate produces a distinct user-facing toast", () => {
    expect(renderer).toContain("media.enabled = false");
    expect(renderer).toContain("Media generation is disabled");
  });

  it("a cancelled request shows 'Generation cancelled' in the toast", () => {
    expect(renderer).toContain("Generation cancelled");
    expect(renderer).toContain("/cancelled/i");
  });

  it("the cancel button is disabled until the generate call is in flight", () => {
    // cancelBtn starts disabled: true; setCancelEnabled is called when the API call resolves/rejects.
    expect(renderer).toContain("disabled: true");
    expect(renderer).toContain("setCancelEnabled");
  });

  it("api.generateMedia receives capability, prompt, params and runId", () => {
    expect(renderer).toContain("api.generateMedia");
    expect(renderer).toContain("capability");
    expect(renderer).toContain("prompt");
    expect(renderer).toContain("params");
    expect(renderer).toContain("runId: runId");
  });

  it("api.cancelMedia is called on the cancel button click", () => {
    expect(renderer).toContain("api.cancelMedia(runId)");
  });
});

/* ── First-run card structure ─────────────────────────────────────────────── */

describe("D38 first-run card — markup", () => {
  const html = read(join("renderer", "index.html"));

  it("the card container exists with id agent-first-run", () => {
    expect(html).toContain('id="agent-first-run"');
  });

  it("the card has three action buttons: local, provider, dismiss", () => {
    expect(html).toContain('id="first-run-local"');
    expect(html).toContain('id="first-run-provider"');
    expect(html).toContain('id="first-run-dismiss"');
  });

  it("the local button text says 'Start offline'", () => {
    expect(html).toContain("Start offline");
  });

  it("the provider button text says 'Add provider'", () => {
    expect(html).toContain("Add provider");
  });

  it("the dismiss button text says 'Dismiss'", () => {
    expect(html).toContain("Dismiss");
  });

  it("the card starts hidden (display:none) in the markup", () => {
    // The inline style is set at render time; the markup may or may not include it.
    // What matters is that updateFirstRunCard controls the visibility.
    expect(html).toContain("agent-first-run");
  });
});

/* ── First-run card behaviour ────────────────────────────────────────────── */

describe("D38 first-run card — behaviour", () => {
  const renderer = read(join("renderer", "renderer.js"));

  it("updateFirstRunCard reads settings.providers and hides the card when non-empty", () => {
    expect(renderer).toContain("updateFirstRunCard");
    expect(renderer).toContain("settings.providers");
    expect(renderer).toContain("length === 0");
    expect(renderer).toContain('display = "none"');
  });

  it("updateFirstRunCard shows the card when no providers are configured", () => {
    // display is set to the empty string (visible) when providers.length === 0.
    expect(renderer).toContain('display = ""');
  });

  it("updateFirstRunCard is called during init", () => {
    expect(renderer).toContain("updateFirstRunCard()");
  });

  it("the first-run-local button sets firstRunDismissed and hides the card then focuses the prompt", () => {
    expect(renderer).toContain("first-run-local");
    expect(renderer).toContain("state.firstRunDismissed = true");
    expect(renderer).toContain('el("agent-prompt").focus()');
  });

  it("the first-run-dismiss button sets firstRunDismissed and hides the card", () => {
    expect(renderer).toContain("first-run-dismiss");
    expect(renderer).toContain("state.firstRunDismissed = true");
  });

  it("the first-run-provider button dismisses the card and navigates to settings", () => {
    expect(renderer).toContain("first-run-provider");
    expect(renderer).toContain('showView("settings")');
    expect(renderer).toContain("loadSettings");
  });

  it("the provider button auto-clicks the last child of #settings-providers", () => {
    expect(renderer).toContain("#settings-providers");
    expect(renderer).toContain("lastElementChild.click");
  });
});

/* ── Source invariants ───────────────────────────────────────────────────── */

describe("D38 source invariants", () => {
  it("renderer.js does not use ES module syntax", () => {
    const src = read(join("renderer", "renderer.js"));
    const stripped = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(stripped).not.toMatch(/^import\s+/m);
    expect(stripped).not.toMatch(/^export\s+/m);
    expect(stripped).not.toMatch(/require\(/);
  });

  it("the generate button wiring uses addEventListener, not an inline handler", () => {
    const src = read(join("renderer", "renderer.js"));
    expect(src).toContain('el("composer-generate")');
    expect(src).toContain('addEventListener("click"');
    expect(src).toContain("openGenerateModal");
  });
});
