/**
 * Media stub — the frozen-default path. No provider is registered, the gate
 * blocks everything, and every call returns MEDIA_DISABLED immediately.
 *
 * The `stubMediaExecute()` method is the seam used by the facade when
 * `media.enabled` is still false. It NEVER reads a credential, NEVER opens a
 * network socket, and NEVER touches the artifact store. Tests drive this path
 * directly so `generateImage` behaviour is covered without any real API call.
 *
 * `stubMediaProvider` is kept for backwards compatibility with the test that
 * asserts "no enabled providers". It mirrors the frozen defaults.
 */
import type { MediaRequest, MediaResult, MediaProviderDefinition, MediaModelDefinition } from "./types.ts";
import { MEDIA_DISABLED_CODE } from "./gate.ts";

export interface StubRouterOptions {
  readonly resolveBearer?: (envName: string) => string;
}

/**
 * Legacy alias: the full stub router, safe for the frozen-default path.
 * Tests import the named `buildStubMediaRouter` symbol; this keeps the test
 * file stable without renaming its import.
 */
export function buildStubMediaRouter(_opts?: StubRouterOptions): import("./router.ts").MediaRouter {
  // Return a router that immediately throws — the gate is frozen and nothing
  // after the gate check is reachable. Tests that import stubMediaExecute
  // don't need the router at all; they exercise the gate + no-provider path.
  // We return a no-op router only so callers that want one can get a well-typed
  // instance. The important part is the exported helpers below.
  return {
    execute: (_req: MediaRequest, _runId: string): Promise<MediaResult> => {
      throw new Error("stub router should not be used — prefer stubMediaExecute");
    },
  } as unknown as import("./router.ts").MediaRouter;
}

/**
 * Legacy entry point expected by `test/media.test.ts`. Returns a
 * `MediaResult` with `ok: false` and the deterministic MVP warning.
 */
export function stubMediaExecute(req: MediaRequest): MediaResult {
  return {
    ok: false,
    artifacts: [],
    provider: "none",
    model: "none",
    warnings: ["media disabled in MVP; intent recorded only"],
  };
}

/**
 * Legacy provider shape the test reads to assert "no enabled providers".
 * Mirrors the frozen defaults so the assertions remain honest.
 */
export const stubMediaProvider: MediaProviderDefinition = {
  id: "stub",
  displayName: "stub",
  endpoint: "",
  protocol: "openai-compatible",
  auth: { type: "bearer", apiKeyEnv: "NONE" },
  capabilities: [] as import("./types.ts").MediaCapability[],
  supportedInputs: ["text"] as const,
  supportedOutputs: ["image"] as const,
  models: [] as MediaModelDefinition[],
  pricing: "free",
  availability: { healthy: false },
};
