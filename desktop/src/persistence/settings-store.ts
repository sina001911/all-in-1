/**
 * Settings store (D1).
 *
 * Stores ONLY mutable desktop settings. Frozen defaults (mainCoder, cost
 * policy, spendBudgetUsd, egress, media) are intentionally NOT part of the
 * settings shape, so no patch can ever alter a frozen default: the type makes
 * it unrepresentable.
 */
import {
  DEFAULT_DESKTOP_SETTINGS,
  type DesktopSettings,
  type SettingsProvider,
  type SettingsProviderModel,
  type SettingsStore,
} from "./types.ts";
import { JsonFileStore } from "./json-store.ts";

const ALLOWED_KEYS: readonly (keyof DesktopSettings)[] = [
  "workspaceRoots",
  "theme",
  "defaultMode",
  "providers",
];

/** An environment-variable NAME only: uppercase, digits, underscore. Never a key value. */
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** A provider id: lowercase, digits, hyphen. Must not collide with built-ins. */
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const BUILTIN_PROVIDER_IDS = new Set(["local"]);
const MAX_MODELS = 64;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteBounded(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(Math.max(n, min), max);
}

/**
 * Validate ONE model declaration. Unknown keys are dropped, types are coerced
 * or rejected, and nothing the caller supplies is trusted.
 */
function sanitizeModel(raw: unknown): SettingsProviderModel | undefined {
  if (!isObject(raw)) return undefined;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (id.length === 0 || id.length > 80) return undefined;
  const out: MutableSettingsProviderModel = { id };
  if (typeof raw.displayName === "string" && raw.displayName.trim().length > 0) {
    out.displayName = raw.displayName.trim().slice(0, 80);
  }
  if (Array.isArray(raw.capabilities)) {
    const caps = raw.capabilities.filter((c) => typeof c === "string" && c.length > 0 && c.length <= 40);
    if (caps.length > 0) out.capabilities = caps as readonly string[];
  }
  const contextLimit = finiteBounded(raw.contextLimit, 1024, 4_000_000);
  if (contextLimit !== undefined) out.contextLimit = contextLimit;
  const outputLimit = finiteBounded(raw.outputLimit, 256, 1_000_000);
  if (outputLimit !== undefined) out.outputLimit = outputLimit;
  if (typeof raw.tools === "boolean") out.tools = raw.tools;
  if (isObject(raw.costPer1MUsd)) {
    const input = finiteBounded(raw.costPer1MUsd.input, 0, 1000);
    const output = finiteBounded(raw.costPer1MUsd.output, 0, 1000);
    if (input !== undefined && output !== undefined) {
      out.costPer1MUsd = { input, output };
    }
  }
  return out;
}

/**
 * Validate ONE provider declaration. This is the main-process boundary: the
 * renderer's input is untrusted, so the endpoint must be a real URL over
 * http(s), the key reference must be an env-var NAME (never a value), and the
 * model list must survive `sanitizeModel`.
 */
export function sanitizeProvider(raw: unknown): SettingsProvider | undefined {
  if (!isObject(raw)) return undefined;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!PROVIDER_ID.test(id) || BUILTIN_PROVIDER_IDS.has(id)) return undefined;

  const endpoint = typeof raw.endpoint === "string" ? raw.endpoint.trim() : "";
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  // A remote endpoint must be https, so a mis-typed address can never send a
  // key in clear text. Loopback may use plain http (a local model server).
  if (parsed.protocol === "http:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost" && parsed.hostname !== "::1") {
    return undefined;
  }

  const rawModels = Array.isArray(raw.models) ? raw.models : [];
  if (rawModels.length === 0) return undefined;
  const models: SettingsProviderModel[] = [];
  for (const m of rawModels.slice(0, MAX_MODELS)) {
    const model = sanitizeModel(m);
    if (model && !models.some((x) => x.id === model.id)) models.push(model);
  }
  if (models.length === 0) return undefined;

  const out: MutableSettingsProvider = { id, endpoint, models };
  if (typeof raw.displayName === "string" && raw.displayName.trim().length > 0) {
    out.displayName = raw.displayName.trim().slice(0, 80);
  }
  // A key VALUE is refused here: only an env-var NAME is accepted, and it must
  // match the name charset. Anything resembling a secret is dropped.
  if (typeof raw.apiKeyEnv === "string" && ENV_NAME.test(raw.apiKeyEnv.trim())) {
    out.apiKeyEnv = raw.apiKeyEnv.trim();
  } else if (raw.apiKeyEnv === null) {
    out.apiKeyEnv = null;
  }
  const timeoutMs = finiteBounded(raw.timeoutMs, 1_000, 600_000);
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;
  const maxRetries = finiteBounded(raw.maxRetries, 0, 10);
  if (maxRetries !== undefined) out.maxRetries = Math.round(maxRetries);
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  return out;
}

/** Validate the whole providers list: de-duplicated and fully sanitized. */
export function sanitizeProviders(raw: unknown): readonly SettingsProvider[] {
  if (!Array.isArray(raw)) return [];
  const out: MutableSettingsProvider[] = [];
  for (const entry of raw.slice(0, 32)) {
    const provider = sanitizeProvider(entry);
    if (provider && !out.some((p) => p.id === provider.id)) out.push(provider);
  }
  return out;
}

/** Mutable builders: assigned field by field during validation, returned as the readonly contract. */
type MutableSettingsProviderModel = {
  id: string;
  displayName?: string;
  capabilities?: readonly string[];
  contextLimit?: number;
  outputLimit?: number;
  tools?: boolean;
  costPer1MUsd?: { input: number; output: number };
};
type MutableSettingsProvider = {
  id: string;
  displayName?: string;
  endpoint: string;
  apiKeyEnv?: string | null;
  models: readonly SettingsProviderModel[];
  timeoutMs?: number;
  maxRetries?: number;
  enabled?: boolean;
};

function sanitize(patch: Partial<DesktopSettings>): Partial<DesktopSettings> {
  const out: {
    workspaceRoots?: readonly string[];
    theme?: "system" | "light" | "dark";
    defaultMode?: "INSPECT" | "SUGGEST" | "BUILD";
    providers?: readonly SettingsProvider[];
  } = {};
  for (const key of ALLOWED_KEYS) {
    if (key in patch) {
      // Providers are validated strictly; scalar keys are copied through
      // without trusting the caller.
      if (key === "providers") {
        out.providers = sanitizeProviders((patch as Record<string, unknown>).providers);
      } else {
        (out as Record<string, unknown>)[key] = (patch as Record<string, unknown>)[key];
      }
    }
  }
  return out;
}

export class FileSettingsStore implements SettingsStore {
  private readonly file: JsonFileStore<DesktopSettings>;
  private current: DesktopSettings;

  constructor(file: JsonFileStore<DesktopSettings>) {
    this.file = file;
    const stored = file.read();
    this.current = stored ? { ...DEFAULT_DESKTOP_SETTINGS, ...sanitize(stored) } : { ...DEFAULT_DESKTOP_SETTINGS };
  }

  get(): DesktopSettings {
    return this.current;
  }

  patch(patch: Partial<DesktopSettings>): DesktopSettings {
    this.current = { ...this.current, ...sanitize(patch) };
    this.save();
    return this.current;
  }

  reset(): void {
    this.current = { ...DEFAULT_DESKTOP_SETTINGS };
    this.save();
  }

  save(): void {
    this.file.write(this.current);
  }
}

export class MemorySettingsStore implements SettingsStore {
  private current: DesktopSettings = { ...DEFAULT_DESKTOP_SETTINGS };

  get(): DesktopSettings {
    return this.current;
  }
  patch(patch: Partial<DesktopSettings>): DesktopSettings {
    this.current = { ...this.current, ...sanitize(patch) };
    return this.current;
  }
  reset(): void {
    this.current = { ...DEFAULT_DESKTOP_SETTINGS };
  }
  save(): void {
    /* in-memory: no-op */
  }
}
