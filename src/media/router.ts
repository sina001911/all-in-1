/**
 * Media router — gates every request through the frozen media policy, then
 * dispatches to the right adapter implementation.
 *
 * The gate runs BEFORE any model selection or transport is touched, so a
 * disabled media config short-circuits the entire path with a typed error.
 * After the gate passes, the router:
 *
 *   1. Picks the right provider from the registered `MediaProviderDefinition`s.
 *   2. Picks an enabled model on that provider for the requested capability.
 *   3. Resolves the credential from the environment at call time.
 *   4. Calls generate() on the adapter.
 *   5. Stores each result in the ArtifactStore (content-addressed).
 *   6. Returns the list of artifact ids plus provider/model provenance.
 *
 * Budget is checked by the caller (the facade or the specialist stack); the
 * router itself does not touch the ledger. That keeps it composable: tests can
 * inject a fake transport without stubbing the budget.
 */
import { mediaGate } from "./gate.ts";
import type {
  MediaRequest,
  MediaResult,
  MediaCapability,
  MediaProviderDefinition,
  MediaModelDefinition,
} from "./types.ts";
import { MediaAdapter } from "./adapter.ts";
import type { HttpTransport } from "../execution/types.ts";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { BudgetLedger } from "../registry/budget.ts";
import { resolveBearerToken } from "../execution/secrets.ts";

export interface MediaRouterOptions {
  /** The transport seam; default uses global `fetch` with a timeout. */
  readonly transport: HttpTransport;
  readonly artifacts: ArtifactStore;
  /** Provider definitions from the user's settings, keyed by id. */
  readonly providers: ReadonlyMap<string, MediaProviderDefinition>;
  /** Bearer token resolver — default reads env vars at call time; tests inject a stub. */
  readonly resolveBearer?: (envName: string) => string;
  /**
   * Optional spend ledger. When present the router reserves the model's declared
   * cost BEFORE the call and commits it after, and counts each settled
   * generation against `maxMediaGenerations`. When absent (tests, headless
   * self-test) the router still enforces the gate and the credential seam but
   * skips the money — that is what makes the same code path exercisable with a
   * fake transport and no real budget.
   */
  readonly budget?: BudgetLedger;
  /** D35: maximum settled media generations. Zero by default (frozen). */
  readonly maxGenerations?: number;
  /**
   * D35: the human's explicit opt-in. When omitted the router falls back to the
   * frozen `mediaGate.enabled` (false), so a fresh install is media-disabled by
   * construction. The desktop stack passes the user's Settings toggle here.
   */
  readonly enabled?: boolean;
  /**
   * D35: maximum attempts per generation. Transient errors (transport
   * failure, HTTP 429, HTTP 5xx) are retried; permanent errors (401/403,
   * 4xx client errors, empty response, no artifacts) are not. Defaults to 1
   * (no retry) — the desktop stack raises this from Settings when the human
   * opts into resilient generation.
   */
  readonly maxRetries?: number;
  /** D35: base delay between retries, in ms. Linear backoff, capped at 30s. */
  readonly retryDelayMs?: number;
}

export class MediaRouter {
  private readonly transport: HttpTransport;
  private readonly artifacts: ArtifactStore;
  private readonly providers: ReadonlyMap<string, MediaProviderDefinition>;
  private readonly resolveBearer: (envName: string) => string;
  private readonly budget?: BudgetLedger;
  private readonly maxGenerations: number;
  private readonly enabled: boolean;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(opts: MediaRouterOptions) {
    this.transport = opts.transport;
    this.artifacts = opts.artifacts;
    this.providers = opts.providers;
    this.resolveBearer = opts.resolveBearer ?? resolveBearerToken;
    this.budget = opts.budget;
    this.maxGenerations = opts.maxGenerations ?? 0;
    this.enabled = opts.enabled ?? mediaGate.enabled;
    this.maxRetries = opts.maxRetries ?? 1;
    this.retryDelayMs = opts.retryDelayMs ?? 1000;
  }

  /**
   * Execute a media request. The media gate is checked first; then the
   * capability is matched against registered providers; finally generate() is
   * called and each result is stored in the artifact store.
   *
   * NOTE: `mediaGate.guard()` returns `never` (throws), which would make
   * TypeScript treat every line after it as unreachable. We guard the
   * *boolean flag* inline instead so the downstream flow stays typed.
   */
  async execute(req: MediaRequest, runId: string): Promise<MediaResult> {
    if (!this.enabled) {
      throw new Error(`Media is disabled in the MVP (media.enabled = false): ${req.capability}`);
    }

    const provider = this.pickProvider(req.capability);
    if (!provider) {
      return {
        ok: false,
        artifacts: [],
        provider: "none",
        model: "none",
        warnings: [`no provider registered for capability ${req.capability}`],
      };
    }

    const modelDef = this.pickModel(provider, req);
    if (!modelDef) {
      return {
        ok: false,
        artifacts: [],
        provider: provider.id,
        model: "none",
        warnings: [`no enabled model for capability ${req.capability} on provider ${provider.id}`],
      };
    }

    // Resolve credential at call time so a fresh key takes effect without a restart.
    let apiKey: string | undefined;
    if (provider.auth.apiKeyEnv) {
      try {
        apiKey = this.resolveBearer(provider.auth.apiKeyEnv);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          artifacts: [],
          provider: provider.id,
          model: modelDef.modelId,
          warnings: [msg],
        };
      }
    }

    // --- BUDGET + GENERATION-COUNT GATE (before any transport call) ---
    // Two independent limits, both enforced here rather than merely displayed:
    //   1. Money: when the user has explicitly set a non-zero budget, the model's
    //      declared cost must fit inside the remaining budget. When budget is
    //      0 (the frozen default), no cost check runs — 0 means "no budget
    //      configured" for media, not "zero spend allowed", so a fresh install
    //      can generate without hitting an accidental ceiling.
    //   2. Slots: the configured maxMediaGenerations cap (0 = disabled).
    // A model with no declared cost is UNKNOWN, not free: it reserves zero and
    // the result is flagged, so the human sees the risk instead of a silent $0.
    if (this.budget) {
      const snap = this.budget.snapshot();
      const budgetIsUnlimited = snap.budgetUsd === 0;
      let reserveAmount = 0;
      if (!budgetIsUnlimited) {
        const cost = modelDef.costEstimateUsd;
        const costUnknown = cost === undefined;
        reserveAmount = costUnknown ? 0 : Math.max(0, cost);
        if (!this.budget.reserve(reserveAmount)) {
          const remaining = Math.max(0, snap.budgetUsd - snap.reservedUsd - snap.spentUsd);
          this.budget.release(reserveAmount);
          return {
            ok: false,
            artifacts: [],
            provider: provider.id,
            model: modelDef.modelId,
            warnings: [
              `budget exceeded for ${modelDef.modelId}: ` +
                `declared cost ${costUnknown ? "unknown" : reserveAmount.toFixed(4)} USD vs ` +
                `remaining ${remaining.toFixed(4)} of ${snap.budgetUsd.toFixed(2)} USD`,
            ],
          };
        }
      }
      if (this.maxGenerations > 0 && this.budget.spentGenerationsCount >= this.maxGenerations) {
        this.budget.release(reserveAmount);
        return {
          ok: false,
          artifacts: [],
          provider: provider.id,
          model: modelDef.modelId,
          warnings: [
            `generation cap reached: ${this.budget.spentGenerationsCount}/${this.maxGenerations} settled; ` +
              `raise maxMediaGenerations in Settings to permit more`,
          ],
        };
      }
    }

    // Build a per-call adapter so the transport seam is honored. The image path
    // is carried from the provider definition so a gateway like OpenRouter that
    // mounts image generation at /images (not /images/generations) still routes
    // correctly. Retry settings come from the router options; the human's
    // abort signal is forwarded so a mid-flight cancel is never retried.
    const adapter = new MediaAdapter({
      transport: this.transport,
      endpoint: provider.endpoint,
      imagePath: provider.imagePath,
      maxRetries: this.maxRetries,
      retryDelayMs: this.retryDelayMs,
    });

    // Resolve reference artifacts (e.g. image-to-image source) from the store.
    let imageUrl: string | undefined;
    const refIds = req.referenceArtifactIds ?? [];
    if (refIds.length > 0) {
      try {
        const ref = this.artifacts.read(refIds[0]);
        imageUrl = `data:${ref.metadata.contentType};base64,${Buffer.from(ref.bytes).toString("base64")}`;
      } catch {
        /* missing reference: proceed without it; the provider will likely reject later */
      }
    }

    const modelId = `${provider.id}/${modelDef.modelId}`;
    let reservedAmount = 0;
    let costUnknown = false;
    if (this.budget) {
      reservedAmount = modelDef.costEstimateUsd !== undefined ? Math.max(0, modelDef.costEstimateUsd) : 0;
      costUnknown = modelDef.costEstimateUsd === undefined;
    }
    try {
      const result = await adapter.generate({
        capability: req.capability,
        model: modelId,
        prompt: req.prompt ?? "",
        size: formatResolution(req.params?.resolution) ?? pickSize(modelDef),
        resolution: formatResolution(req.params?.resolution),
        durationSeconds: req.params?.durationSeconds,
        aspectRatio: req.params?.aspectRatio,
        n: 1,
        seed: req.params?.seed,
        imageUrl,
        referenceImages: refIds.length > 0 ? refIds : undefined,
        apiKey,
        signal: req.signal,
      });

      // Store each artifact in the content-addressed store.
      const storedArtifacts: Array<{ readonly artifactId: string; readonly modality: import("./types.ts").MediaModality; readonly mimeType: string; readonly bytes: number }> = [];
      for (const art of result.artifacts) {
        const bytes = base64ToBytes(art.b64Json);
        const stored = this.artifacts.store({
          kind: "capture",
          bytes,
          contentType: art.mimeType,
          runId,
          labels: { source: "media-generation", capability: req.capability },
        });
        storedArtifacts.push({
          artifactId: stored.metadata.artifactId,
          modality: "IMAGE" as const,
          mimeType: art.mimeType,
          bytes: stored.metadata.bytes,
        });
      }

      // Settle the ledger: release the reservation, commit the actual cost, and
      // count one settled generation. A free model still consumes a slot.
      //
      // Cost resolution order: the provider's reported cost first (most
      // accurate), then the model's declared cost (a verified price the user
      // supplied), then nothing — `undefined`, flagged as unknown. Zero is
      // only ever a real cost when the provider explicitly reports it.
      if (this.budget) {
        this.budget.release(reservedAmount);
        const actualCost = resolveCost(result.costUsd, modelDef.costEstimateUsd);
        if (typeof actualCost === "number" && Number.isFinite(actualCost) && actualCost > 0) {
          this.budget.commit(actualCost);
        }
        this.budget.incrementGeneration();
      }

      // Computed once after settle so the return shape and the ledger commit
      // agree on the same value. Without this, the two copies could drift.
      const actualCost = resolveCost(result.costUsd, modelDef.costEstimateUsd);

      return {
        ok: result.ok,
        artifacts: storedArtifacts as unknown as import("./types.ts").MediaResult["artifacts"],
        provider: provider.id,
        model: modelDef.modelId,
        warnings: result.warnings,
        costUsd: actualCost,
        costUnknown: actualCost === undefined,
        // Always defined: with no ledger the cap is unbounded, so the count
        // is `maxGenerations` (the configured ceiling), not `undefined`.
        generationsRemaining: this.budget
          ? Math.max(0, this.maxGenerations - this.budget.spentGenerationsCount)
          : this.maxGenerations,
      };
    } catch (err) {
      // Release the reservation on any failure: a failed call must not pin
      // budget it never spent.
      if (this.budget) this.budget.release(reservedAmount);
      // Typed media errors propagate; everything else is wrapped as a warning.
      if (isMediaError(err)) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        artifacts: [],
        provider: provider.id,
        model: modelDef.modelId,
        warnings: [msg],
      };
    }
  }

  private pickProvider(capability: string): MediaProviderDefinition | null {
    for (const provider of this.providers.values()) {
      if (provider.capabilities.includes(capability as MediaCapability)) return provider;
    }
    return null;
  }

  private pickModel(provider: MediaProviderDefinition, req: MediaRequest): MediaModelDefinition | null {
    for (const m of provider.models) {
      if (!m.enabled) continue;
      if (!m.capabilities.includes(req.capability as MediaCapability)) continue;
      return m;
    }
    return null;
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function pickSize(model: MediaModelDefinition): string | undefined {
  const presets = model.resolution?.presets;
  if (!presets || presets.length === 0) return undefined;
  const [w, h] = presets[0];
  return `${w}x${h}`;
}

/** The human's resolution override, as a "WxH" string the adapter forwards. */
function formatResolution(resolution?: readonly [number, number]): string | undefined {
  if (!resolution) return undefined;
  const [w, h] = resolution;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return undefined;
  return `${w}x${h}`;
}

/**
 * Resolve the settled cost for a generation. The provider's reported cost is
 * authoritative when it is a finite positive number; otherwise the model's
 * declared cost is used; otherwise `undefined` (unknown). Zero is only ever a
 * real cost when the provider explicitly reports it.
 */
function resolveCost(reported: unknown, declared: number | undefined): number | undefined {
  if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) return reported;
  if (typeof declared === "number" && Number.isFinite(declared) && declared > 0) return declared;
  return undefined;
}

function isMediaError(e: unknown): boolean {
  return e instanceof Error && typeof (e as unknown as Record<string, unknown>)["__media"] === "object";
}

/**
 * Convenience: build a router from a provider definition map. In production
 * the desktop stack populates this from the user's settings; tests inject a
 * fake map so no credential is ever read.
 */
export function buildMediaRouter(opts: MediaRouterOptions): MediaRouter {
  return new MediaRouter(opts);
}
