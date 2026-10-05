/**
 * Project detector. Runs every adapter's `detect()` and selects the highest
 * confidence result. Ambiguity (top two scores within 0.15) is surfaced
 * explicitly rather than silently resolved.
 */
import type { AdapterRegistry } from "./registry.ts";
import type { Detection, ProjectAdapter } from "./types.ts";

const AMBIGUITY_THRESHOLD = 0.15;

export interface DetectResult {
  readonly adapter: ProjectAdapter;
  readonly detection: Detection;
}

export function detectProject(registry: AdapterRegistry, root: string): DetectResult {
  const scored: DetectResult[] = [];
  for (const adapter of registry.list()) {
    const detection = adapter.detect(root);
    scored.push({ adapter, detection });
  }
  const fallback = registry.getFallback();
  if (fallback) {
    scored.push({ adapter: fallback, detection: fallback.detect(root) });
  }

  scored.sort((a, b) => b.detection.confidence - a.detection.confidence);
  const top = scored[0];
  if (!top) throw new Error("No adapters registered");

  const second = scored[1];
  const ambiguous =
    !!second && Math.abs(top.detection.confidence - second.detection.confidence) <= AMBIGUITY_THRESHOLD;

  // Ambiguity is surfaced rather than silently resolved: when the top two
  // scores fall within the threshold, `ambiguous` is set to true. The
  // highest-confidence adapter still wins; the caller (Atria) decides whether
  // the tie warrants asking the user.
  return { adapter: top.adapter, detection: { ...top.detection, ambiguous } };
}
