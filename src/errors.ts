/**
 * Typed failure model.
 *
 * Every runtime failure surfaces as an error carrying a machine-readable `code`
 * discriminant plus a stable `category`, so callers can branch on `code`
 * without parsing messages. No `any` ever escapes a catch boundary.
 *
 * Categories:
 *   - `security`  : a policy (host, isolation, quarantine) blocked an action.
 *   - `browser`   : the browser engine could not start, navigate, or capture.
 *   - `artifact`  : artifact storage rejected a write or read.
 *   - `config`    : invalid configuration or environment reference.
 *   - `unavailable`: a required optional capability (e.g. Playwright) is absent.
 */

export const ERROR_CATEGORIES = [
  "security",
  "browser",
  "artifact",
  "config",
  "unavailable",
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export const ERROR_CODES = [
  // security
  "HOST_BLOCKED",
  "PATH_TRAVERSAL_BLOCKED",
  "MODE_VIOLATION",
  // browser
  "BROWSER_UNAVAILABLE",
  "BROWSER_LAUNCH_FAILED",
  "NAVIGATION_FAILED",
  "NAVIGATION_TIMEOUT",
  "SCREENSHOT_FAILED",
  "PAGE_CLOSED",
  // artifact
  "ARTIFACT_WRITE_FAILED",
  "ARTIFACT_READ_FAILED",
  "ARTIFACT_NOT_FOUND",
  "ARTIFACT_TOO_LARGE",
  "RETENTION_ENFORCEMENT_FAILED",
  // vision
  "VISION_PROVIDER_UNAVAILABLE",
  "VISION_CAPABILITY_MISMATCH",
  "VISION_ANALYSIS_FAILED",
  "UNSUPPORTED_IMAGE",
  "IMAGE_TOO_LARGE",
  // provider / model routing
  "MODEL_NOT_FOUND",
  "MODEL_UNAVAILABLE",
  "PROVIDER_ISOLATION_VIOLATION",
  "CAPABILITY_NOT_SUPPORTED",
  // execution (P4): the live call path
  "EGRESS_BLOCKED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_UNREACHABLE",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_CALL_FAILED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_CANCELLED",
  "CREDENTIAL_UNAVAILABLE",
  "SELECTION_FAILED",
  "APPROVAL_REQUIRED",
  "BUDGET_EXCEEDED",
  // specialists + workflow (P5)
  "SPECIALIST_NOT_FOUND",
  "SCHEMA_INVALID",
  "STRUCTURED_OUTPUT_INVALID",
  "WORKFLOW_AUTO_LIMIT",
  "WORKFLOW_ESCALATED",
  "WORKFLOW_CANCELLED",
  // config
  "INVALID_CONFIG",
  "INVALID_ENV_REF",
  // tool runtime (D2)
  "TOOL_NOT_FOUND",
  "TOOL_VALIDATION_FAILED",
  "TOOL_PERMISSION_DENIED",
  "TOOL_APPROVAL_REQUIRED",
  "TOOL_APPROVAL_DENIED",
  "TOOL_TIMEOUT",
  "TOOL_CANCELLED",
  "TOOL_EXECUTION_FAILED",
  "TOOL_LIMIT_EXCEEDED",
  "TOOL_UNAVAILABLE",
  // agent runtime (D3)
  "AGENT_CANCELLED",
  "AGENT_TURN_LIMIT",
  "AGENT_DRY_RUN_REQUIRED",
  "AGENT_NO_GATEWAY",
  "AGENT_ESCALATED",
  // generic
  "NOT_IMPLEMENTED",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class AllInOneError extends Error {
  readonly category: ErrorCategory;
  readonly code: ErrorCode;
  readonly cause?: unknown;
  readonly retryable: boolean;

  constructor(
    message: string,
    code: ErrorCode,
    category: ErrorCategory,
    opts: { cause?: unknown; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "AllInOneError";
    this.code = code;
    this.category = category;
    this.cause = opts.cause;
    this.retryable = opts.retryable ?? false;
  }
}

export function isAllInOneError(e: unknown): e is AllInOneError {
  return e instanceof AllInOneError;
}

/** Narrow any thrown value into an AllInOneError, wrapping unknown shapes. */
export function toAllInOneError(
  e: unknown,
  fallback: { code: ErrorCode; category: ErrorCategory; message: string },
): AllInOneError {
  if (isAllInOneError(e)) return e;
  const message =
    e instanceof Error
      ? `${e.name}: ${e.message}`
      : typeof e === "string"
        ? e
        : fallback.message;
  return new AllInOneError(message, fallback.code, fallback.category, {
    cause: e,
    retryable: false,
  });
}

/** A `Result` discriminated union for the (few) paths that must not throw. */
export type Result<T, E = AllInOneError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E extends AllInOneError>(error: E): Result<never, E> {
  return { ok: false, error };
}
