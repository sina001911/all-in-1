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
  type SettingsStore,
} from "./types.ts";
import { JsonFileStore } from "./json-store.ts";

const ALLOWED_KEYS: readonly (keyof DesktopSettings)[] = [
  "workspaceRoots",
  "theme",
  "defaultMode",
];

function sanitize(patch: Partial<DesktopSettings>): Partial<DesktopSettings> {
  const out: Partial<DesktopSettings> = {};
  for (const key of ALLOWED_KEYS) {
    if (key in patch) {
      // Record type gives unknown; copy through without trusting the caller.
      (out as Record<string, unknown>)[key] = (patch as Record<string, unknown>)[key];
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
