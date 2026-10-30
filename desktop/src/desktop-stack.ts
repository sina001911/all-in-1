/**
 * Desktop stack bootstrap (D1).
 *
 * Assembles the existing all_in_1 core (`buildSpecialistStack`, unchanged
 * behaviour) with the desktop's persistence and credential layers. The core is
 * the security spine; this module only supplies stores and a log sink.
 *
 * Frozen posture is preserved by construction:
 *   - policy is left at its default (PREFERRED_FREE: free first, paid with
 *     approval — the frozen default was relaxed from FREE_ONLY in D31);
 *   - budget is constructed from the user's settings (0 by default, the
 *     spendBudgetUsd frozen default);
 *   - no allowHosts are passed, so egress stays deny-all;
 *   - no remote provider adapter is registered, only the deterministic local
 *     adapter that `buildSpecialistStack` always registers.
 *
 * The Electron main process passes the OS data directory and the safeStorage
 * credential provider; tests and the headless self-test pass a temp directory
 * and a memory credential provider.
 */
import { buildSpecialistStack, type SpecialistStack } from "../../src/specialists/stack.ts";
import { SwappablePortal } from "../../src/execution/swappable-portal.ts";
import type { InvocationPortal } from "../../src/execution/engine.ts";
import { FROZEN_DEFAULTS } from "../../src/config/schema.ts";
import { buildToolRuntime, type ToolRuntime } from "../../src/tools/index.ts";
import { buildAgentRuntime, type AgentRuntime } from "../../src/agent/index.ts";
import { ProviderModelGateway } from "../../src/agent/provider-gateway.ts";
import { PersistentApprovalStore } from "./persistence/persistent-approval-store.ts";
import { PersistentBudgetLedger } from "./persistence/persistent-budget-ledger.ts";
import { FileRunStore } from "./persistence/run-store.ts";
import { FileUsageStore } from "./persistence/usage-store.ts";
import { FileSettingsStore } from "./persistence/settings-store.ts";
import { FileLogStore } from "./persistence/log-store.ts";
import { JsonFileStore, JsonlAppendStore } from "./persistence/json-store.ts";
import { ArtifactStore } from "../../src/artifacts/store.ts";
import { buildVisionAnalyzer, type VisualAnalyzer } from "../../src/vision/index.ts";
import { buildTextAnalyzer, type TextAnalyzer } from "../../src/vision/text-analyzer.ts";
import { MediaRouter, buildMediaRouter } from "../../src/media/router.ts";
import type {
  HttpTransport,
  HttpResponse,
} from "../../src/execution/types.ts";
import type {
  MediaCapability,
  MediaModality,
  MediaModelDefinition,
  MediaProviderDefinition,
  MediaRequest,
  MediaResult,
} from "../../src/media/types.ts";
import { MEDIA_CAPABILITIES } from "../../src/media/types.ts";
import type {
  RunStore,
  UsageStore,
  SettingsStore,
  LogStore,
  DesktopSettings,
  SettingsProvider,
} from "./persistence/types.ts";
import { resolveDataPaths, type DataPaths } from "./persistence/paths.ts";
import { LogStoreSink } from "./log-sink.ts";
import { CancellationHub } from "./cancellation.ts";
import { AgentStreamBridge } from "./stream-bridge.ts";
import type { CredentialProvider } from "./credentials/types.ts";
import { InteractiveToolApprover } from "./tools/approver.ts";
import { FileToolAuditStore } from "./tools/audit-store.ts";
import { DesktopWorkspaceRoots } from "./tools/workspace-roots.ts";

export interface DesktopStack {
  readonly core: SpecialistStack;
  readonly paths: DataPaths;
  readonly runStore: RunStore;
  readonly usageStore: UsageStore;
  readonly settingsStore: SettingsStore;
  readonly logStore: LogStore;
  /**
   * Content-addressed artifact store (D35). Screenshots, captures, and user
   * uploads land here; the renderer never sees the base path, only the
   * artifact ids the facade hands back. Retention is enforced on every
   * reload so a stale capture cannot accumulate forever.
   */
  readonly artifacts: ArtifactStore;
  /**
   * D35: the visual analyzer. User-uploaded images and captured screenshots
   * are analyzed through this path; the VISION role routes through the frozen
   * PREFERRED_FREE policy, so a zero-budget install still analyzes for free
   * via the deterministic fake. No credential is read, requested, or logged.
   */
  readonly vision: VisualAnalyzer;
  /**
   * D35: the text analyzer. A text upload is decoded and summarized locally —
   * no vision provider, no network call, no credential. The VISION role is
   * untouched; this path exists so the artifact surface can answer "what is
   * this file?" for every content type the store accepts.
   */
  readonly text: TextAnalyzer;
  /**
   * D35: the media router. Gates every request through the frozen media
   * policy (media.enabled = false in the MVP) BEFORE any provider lookup or
   * transport call, then dispatches to the right adapter. The transport seam
   * is injectable so tests can feed it a fake response without opening a
   * socket. The gate itself is the frozen default: nothing here can bypass it.
   */
  readonly media: MediaRouter;
  /**
   * D35: per-call abort signals for media generation. The renderer cannot
   * pass an AbortSignal over IPC, so the desktop stack owns the registry:
   * `signalFor(runId)` returns the controller for an in-flight call (or
   * undefined), and `cancelMediaRun(runId)` aborts it. A cancelled attempt
   * is never retried.
   */
  readonly mediaSignals: {
    readonly signalFor: (runId: string) => AbortSignal | undefined;
    readonly cancel: (runId: string) => boolean;
  };
  readonly credentials: CredentialProvider;
  readonly cancellation: CancellationHub;
  readonly approvals: PersistentApprovalStore;
  readonly budget: PersistentBudgetLedger;
  readonly tools: ToolRuntime;
  readonly toolApprover: InteractiveToolApprover;
  readonly workspaceRoots: DesktopWorkspaceRoots;
  readonly agent: AgentRuntime;
  readonly agentGateway: ProviderModelGateway;
  /** Progressive-stream bridge (D12): pull-only preview events, in memory only. */
  readonly streamBridge: AgentStreamBridge;
  /** Workflow bridge (D16): separate from AgentStreamBridge to avoid runId bleed. */
  readonly workflowStreamBridge: AgentStreamBridge;
  /** Warnings from user-provider registration (D7), shown in the UI. Live: reflects the current stack after a reload. */
  readonly providerWarnings: readonly string[];
  /**
   * Rebuild the provider-dependent core (catalogue, adapters, egress, engine,
   * runner) from current settings and atomically swap it in (D10). The old
   * stack keeps serving in-flight invocations; new invocations use the new
   * one. Persistent stores, the tool runtime, and the agent runtime are
   * untouched. If the rebuild throws, the previous stack stays in place.
   */
  reloadProviders(): readonly string[];
  readonly frozenDefaults: typeof FROZEN_DEFAULTS;
}

export interface DesktopStackOptions {
  /** OS data directory (Electron `app.getPath("userData")` or a temp dir). */
  readonly baseDir: string;
  readonly credentials: CredentialProvider;
  /** Override stores for tests; when omitted, file-backed stores are created. */
  readonly overrides?: {
    readonly runStore?: RunStore;
    readonly usageStore?: UsageStore;
    readonly settingsStore?: SettingsStore;
    readonly logStore?: LogStore;
    /**
     * Inject the artifact store (D35). Tests pass an in-memory-backed
     * instance so artifact ids stay deterministic; production builds leave
     * this unset and the file-backed store is created from paths.artifacts.
     */
    readonly artifacts?: ArtifactStore;
    /**
     * Inject the engine portal the specialist runner invokes (D25). The
     * observability seam still wraps it, so logging and redaction are
     * unchanged. Production builds leave this unset.
     */
    readonly engine?: InvocationPortal;
    /**
     * Inject the engine portal the AGENT gateway invokes (D27). The agent path
     * does not go through the specialist runner, so `overrides.engine` does not
     * reach it; this is the equivalent seam for tests that need a deterministic
     * paid agent outcome. Production builds leave this unset and the agent
     * speaks to the same swappable portal as everything else, so a provider
     * hot-reload still takes effect for agent turns.
     */
    readonly agentEngine?: InvocationPortal;
  };
}

export function buildDesktopStack(opts: DesktopStackOptions): DesktopStack {
  const paths = resolveDataPaths(opts.baseDir);
  const logStore = opts.overrides?.logStore ?? new FileLogStore(new JsonlAppendStore(paths.root, "logs.jsonl"));
  const runStore = opts.overrides?.runStore ?? new FileRunStore(new JsonFileStore(paths.root, "runs.json"));
  const usageStore = opts.overrides?.usageStore ?? new FileUsageStore(new JsonFileStore(paths.root, "usage.json"));
  const settingsStore =
    opts.overrides?.settingsStore ?? new FileSettingsStore(new JsonFileStore(paths.root, "settings.json"));

  // Persistent core stores, hydrated from disk then injected into the core.
  const approvals = new PersistentApprovalStore(
    undefined,
    new JsonFileStore(paths.root, "approvals.json"),
  );

  // D7: the user's registered providers are read from settings BEFORE the core
  // stack is built, so the catalogue, adapters, and egress policy the engine
  // holds are the ones the user configured.
  const settings = settingsStore.get();

  // The spend budget is user-configurable from the Settings UI. The frozen
  // default is 0 (no spend); raising it is an explicit human act. The ledger
  // is reconstructed on every reload so a change takes effect atomically with
  // the provider rebuild, and the reserved/spent state is restored from the
  // same file the old ledger persisted to.
  let budget = new PersistentBudgetLedger(
    settings.budgetUsd,
    undefined,
    new JsonFileStore(paths.root, "budget.json"),
  );

  // D35: the artifact store. Content-addressed, confined to paths.artifacts,
  // and swept on every reload so a capture cannot outlive its run forever.
  // The retention knobs come from settings; the frozen default keeps every
  // artifact for 90 days and the 64 most recent per kind.
  let artifacts =
    opts.overrides?.artifacts ??
    new ArtifactStore({
      baseDir: paths.artifacts,
      retentionDays: settingsStore.get().artifactRetentionDays ?? 90,
      keepRuns: settingsStore.get().artifactKeepRuns ?? 64,
    });

  // D35: the visual analyzer. The VISION role routes through the frozen
  // PREFERRED_FREE policy and the zero budget, so a fresh install analyzes
  // user uploads for free via the deterministic fake. No credential is read.
  const vision = buildVisionAnalyzer({
    maxImageEdge: FROZEN_DEFAULTS.vision.maxImageEdge,
    locale: FROZEN_DEFAULTS.vision.locale,
  });
  // D35: the text analyzer is local-only — it decodes text/* uploads and
  // summarizes them with no network call and no credential.
  const text = buildTextAnalyzer();

  // D35: the media router. The gate is frozen (media.enabled = false in the
  // MVP), so every media call short-circuits with MEDIA_DISABLED before any
  // provider lookup or transport call. The provider map is empty by default:
  // the user registers a media provider explicitly, and the router then
  // routes by capability. The transport seam is injectable so tests can feed
  // it a fake response without opening a socket. The spend ledger is wired in
  // so the router reserves budget BEFORE the call and commits it after — the
  // frozen default (budget 0) means no generation can ever reserve anything.
  let media = buildMediaRouter({
    transport: defaultHttpTransport(),
    artifacts,
    providers: buildMediaProviders(settingsStore.get().providers),
    budget,
    maxGenerations: FROZEN_DEFAULTS.media.budget.maxMediaGenerations,
    enabled: settingsStore.get().mediaEnabled,
    maxRetries: FROZEN_DEFAULTS.media.maxRetries,
    retryDelayMs: FROZEN_DEFAULTS.media.retryDelayMs,
  });

  /**
   * D35: per-call abort signals for media generation. The renderer cannot
   * pass an AbortSignal over the IPC bridge, so the desktop stack owns a
   * registry: the facade issues a run id, the main process stores the
   * controller, and a `cancelMediaRun` IPC call aborts it. A cancelled
   * attempt is never retried — the adapter throws a typed `cancelled`
   * media error and the router releases the budget reservation.
   */
  const mediaSignals = new Map<string, AbortController>();
// A cancel that arrives before the generation asks for a signal. The
// controller is created lazily in `signalFor`, so a fast double-click on
// "Cancel" can land before the adapter has a signal to abort. Record the
// intent here and honour it when the controller is finally created.
const pendingMediaAborts = new Set<string>();

  const buildCore = (): SpecialistStack =>
    buildSpecialistStack({
      approvals,
      budget,
      logSink: new LogStoreSink(logStore),
      // D25: a test may inject a deterministic paid engine; the observability
      // seam still wraps it, so logging and redaction are unchanged.
      engine: opts.overrides?.engine,
      // The desktop runs an agent loop, which needs a tool-capable model. This
      // opts in the deterministic local agent model ONLY as the built-in; a user
      // may additionally register providers below. The frozen posture is
      // unchanged for a fresh install: no providers, deny-all egress, budget 0.
      agentModel: true,
      // D7/D10: register the user's providers and open egress to exactly the
      // hosts they registered a provider against — nothing more. Loopback is
      // permitted by the default policy already, so a local model server needs
      // no entry.
      providers: settingsStore.get().providers,
      allowHosts: hostsForProviders(settingsStore.get().providers),
    });

  let current = buildCore();
  // D10: the gateway, the runner path, and every facade read go through live
  // references, so a rebuilt core is seen without re-binding constructors.
  const portal = new SwappablePortal(current.stack.engine);

  // D2: the privileged tool runtime. Its workspace roots are the directories
  // the user has opened, and its data directory is denied to every tool — a
  // tool can never read the credential store or rewrite its own audit trail.
  // The approver is interactive: privileged tools wait for the human.
  const workspaceRoots = new DesktopWorkspaceRoots(settingsStore, paths.root);
  const toolApprover = new InteractiveToolApprover();
  const tools = buildToolRuntime({
    workspace: workspaceRoots.manager(),
    approver: toolApprover,
    audit: new FileToolAuditStore(new JsonlAppendStore(paths.root, "tool-audit.jsonl")),
  });

  // D4: the agent runtime. The gateway routes every turn through the execution
  // engine, hence through the frozen gates; the agent holds the tool runtime,
  // never the approver, so a tool request from the model can only be settled
  // by the human behind `toolApprover`. D10: the gateway sees the swappable
  // portal, so a rebuilt provider stack takes effect for the agent too. D27: a
  // test may inject a deterministic paid engine for the agent path alone; it
  // gets its own portal, so nothing else in the stack is affected.
  const agentGateway = new ProviderModelGateway({
    engine: opts.overrides?.agentEngine ? new SwappablePortal(opts.overrides.agentEngine) : portal,
  });
  const agent = buildAgentRuntime({ tools, gateway: agentGateway });

  const stack: DesktopStack = {
    get core() {
      return current;
    },
    paths,
    runStore,
    usageStore,
    settingsStore,
    logStore,
    artifacts,
    vision,
    text,
    media,
    credentials: opts.credentials,
    mediaSignals: {
      signalFor: (runId: string) => {
        // Create-on-first-use, mirroring CancellationHub. A plain lookup that
        // returns undefined would hand the adapter a no-op signal: the human's
        // "Cancel generation" would call cancel(), find nothing, and the
        // in-flight fetch would keep running to completion.
        let controller = mediaSignals.get(runId);
        if (!controller) {
          controller = new AbortController();
          mediaSignals.set(runId, controller);
        }
        // Honour a cancel that arrived before this signal was requested: the
        // adapter must never receive a live signal for a run the human already
        // cancelled.
        if (pendingMediaAborts.has(runId)) {
          controller.abort();
          pendingMediaAborts.delete(runId);
        }
        return controller.signal;
      },
      cancel: (runId: string) => {
        const controller = mediaSignals.get(runId);
        if (controller) {
          controller.abort();
          mediaSignals.delete(runId);
          return true;
        }
        // No controller yet — the generation has not asked for a signal. Park
        // the intent so `signalFor` aborts the controller the moment it is
        // created, instead of returning a live one.
        pendingMediaAborts.add(runId);
        return true;
      },
    },
    cancellation: new CancellationHub(),
    approvals,
    get budget() {
      return budget;
    },
    tools,
    toolApprover,
    workspaceRoots,
    agent,
    agentGateway,
    streamBridge: new AgentStreamBridge(),
    workflowStreamBridge: new AgentStreamBridge(),
    // D7: the warnings from user-provider registration, surfaced in the UI so a
    // bad entry is explained rather than silently ignored. Live after reload.
    get providerWarnings() {
      return current.stack.registrationWarnings;
    },
    reloadProviders() {
      // Re-read the spend budget from settings FIRST: the ledger is
      // reconstructed with the current budgetUsd, restoring reserved/spent
      // state from the same file, so a budget change takes effect atomically
      // with the provider rebuild. If the rebuild throws, nothing below runs
      // and the old stack keeps serving both in-flight and new invocations.
      const s = settingsStore.get();
      if (s.budgetUsd !== budget.budgetUsd) {
        budget = new PersistentBudgetLedger(
          s.budgetUsd,
          undefined,
          new JsonFileStore(paths.root, "budget.json"),
        );
      }
      // D35: the artifact store is rebuilt from settings too, so a retention
      // change takes effect atomically with the provider rebuild. The sweep
      // is best-effort: a pruning failure is logged and returned, never fatal.
      if (
        s.artifactRetentionDays !== undefined &&
        s.artifactRetentionDays !== artifacts.retentionDays ||
        s.artifactKeepRuns !== undefined &&
        s.artifactKeepRuns !== artifacts.keepRuns
      ) {
        artifacts = new ArtifactStore({
          baseDir: paths.artifacts,
          retentionDays: s.artifactRetentionDays ?? 90,
          keepRuns: s.artifactKeepRuns ?? 64,
        });
      }
      // D35: the media router is rebuilt from the current provider list, so a
      // media provider registered through Settings takes effect atomically
      // with the provider rebuild. The gate is frozen; nothing here can change
      // it — only a media provider can route a request past it. The ledger is
      // re-read above, so a budget change takes effect atomically here too.
      media = buildMediaRouter({
        transport: defaultHttpTransport(),
        artifacts,
        providers: buildMediaProviders(s.providers),
        budget,
        maxGenerations: FROZEN_DEFAULTS.media.budget.maxMediaGenerations,
        enabled: s.mediaEnabled,
        maxRetries: FROZEN_DEFAULTS.media.maxRetries,
        retryDelayMs: FROZEN_DEFAULTS.media.retryDelayMs,
      });
      const next = buildCore();
      portal.swap(next.stack.engine);
      current = next;
      return next.stack.registrationWarnings;
    },
    frozenDefaults: FROZEN_DEFAULTS,
  };
  return stack;
}

/**
 * The hosts egress is opened for: exactly the hosts of the providers the user
 * registered. A loopback provider contributes nothing (loopback is already
 * allowed), and an unparseable endpoint contributes nothing — its provider is
 * skipped at registration with a warning anyway.
 */
export function hostsForProviders(providers: readonly SettingsProvider[]): readonly string[] {
  const hosts: string[] = [];
  for (const provider of providers) {
    try {
      const host = new URL(provider.endpoint).hostname.toLowerCase();
      if (host && !hosts.includes(host) && !isLoopbackHost(host)) hosts.push(host);
    } catch {
      /* unparseable: registration reports it */
    }
  }
  return hosts;
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/**
 * Convert the user's SettingsProvider declarations into MediaProviderDefinition
 * entries the MediaRouter can dispatch on. Only providers whose models declare
 * at least one MEDIA_CAPABILITY produce an entry; everything else is skipped.
 * The gate (media.enabled = false) still blocks the call — this mapping only
 * decides WHICH provider to talk to when the gate permits it.
 */
function buildMediaProviders(providers: readonly SettingsProvider[]): Map<string, MediaProviderDefinition> {
  const result = new Map<string, MediaProviderDefinition>();
  for (const provider of providers) {
    const mediaModels: MediaModelDefinition[] = [];
    const allCapabilities = new Set<MediaCapability>();

    for (const model of provider.models) {
      const caps = (model.mediaCapabilities ?? []).filter(
        (c): c is MediaCapability => MEDIA_CAPABILITIES.includes(c as never),
      );
      if (caps.length === 0) continue;

      // Infer modality from capabilities: anything with _VIDEO is video-first,
      // anything with _IMAGE is image-first, the rest is multimodal.
      let modality: MediaModality = "MULTIMODAL";
      if (caps.some((c) => c.includes("_VIDEO"))) modality = "VIDEO";
      else if (caps.some((c) => c.includes("_IMAGE"))) modality = "IMAGE";

      const hasImage = caps.some((c) => c.includes("IMAGE"));
      const hasVideo = caps.some((c) => c.includes("VIDEO"));
      const hasAudio = caps.some((c) => c.includes("AUDIO"));
      const has3d = caps.some((c) => c.includes("3D"));

      const outputTypes: string[] = [];
      if (hasImage) outputTypes.push("image");
      if (hasVideo) outputTypes.push("video");
      if (hasAudio) outputTypes.push("audio");
      if (has3d) outputTypes.push("3d");

      mediaModels.push({
        provider: provider.id,
        modelId: model.id,
        displayName: model.displayName ?? model.id,
        modality,
        inputTypes: ["text", "image"],
        outputTypes,
        capabilities: caps,
        pricing: "unknown",
        // D35: a user may declare a per-generation cost for a media model. It is
        // carried through so the router can reserve budget before the call and
        // commit the actual spend after — never invented, never defaulted.
        costEstimateUsd: model.costEstimateUsd,
        availability: true,
        priority: 0,
        enabled: provider.enabled !== false,
      });

      for (const c of caps) allCapabilities.add(c);
    }

    if (mediaModels.length === 0) continue;

    const apiKeyEnv = provider.apiKeyEnv ?? "";
    result.set(provider.id, {
      id: provider.id,
      displayName: provider.displayName ?? provider.id,
      endpoint: provider.endpoint,
      protocol: provider.protocol ?? "openai-compatible",
      auth: {
        type: provider.apiKeyEnv ? "bearer" : "query",
        apiKeyEnv,
      },
      // D35: the image-generation path. OpenRouter mounts it at /images; the
      // OpenAI-compatible default is /images/generations. When absent the
      // adapter falls back to the default, so a provider that does not set this
      // still gets the standard path.
      imagePath: provider.imagePath,
      capabilities: [...allCapabilities],
      supportedInputs: ["text", "image"],
      supportedOutputs: mediaModels[0].outputTypes,
      models: mediaModels,
      pricing: "unknown",
      availability: { healthy: true },
    });
  }
  return result;
}

/** Minimal HttpTransport backed by global fetch, used when no seam is injected. */
function defaultHttpTransport(): HttpTransport {
  return {
    async post(
      url: string,
      body: unknown,
      headers: Record<string, string>,
      signal?: AbortSignal,
    ): Promise<HttpResponse> {
      // Forward the caller's signal so a human cancel aborts the fetch. The
      // adapter also wraps with its own timeout; without this, "Cancel" was a
      // silent no-op in production because the real fetch ran to completion.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_MEDIA_TIMEOUT_MS);
      const onCallerAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", onCallerAbort, { once: true });
      }
      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const parsed = await response.json();
        return { status: response.status, body: parsed };
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onCallerAbort);
      }
    },
  };
}

/** Mirrors the adapter's own timeout so a hung provider cannot hang the UI. */
const DEFAULT_MEDIA_TIMEOUT_MS = 60_000;

/** Convenience accessor for the mutable settings (typed, frozen-free). */
export function desktopSettings(stack: DesktopStack): DesktopSettings {
  return stack.settingsStore.get();
}
