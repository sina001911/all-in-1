/**
 * Electron `safeStorage` credential provider (D1).
 *
 * On Windows `safeStorage` encrypts with DPAPI under the user's account, so the
 * credential file on disk is unusable to another user or process. Values are
 * never written to logs, never returned through the facade, and only ever held
 * for the duration of a single resolution.
 *
 * If encryption is unavailable the provider REFUSES to store or resolve rather
 * than falling back to plaintext. That is a deliberate hard refusal: a silent
 * plaintext fallback would weaken the credential boundary for convenience.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CredentialProvider } from "./types.ts";
import { CredentialUnavailableError } from "./types.ts";

/**
 * The narrow slice of Electron's `safeStorage` this module needs, declared here
 * so tests can inject a fake without importing Electron.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

interface StoredCredential {
  readonly [name: string]: string; // base64 of the encrypted value
}

export class ElectronSafeStorageCredentialProvider implements CredentialProvider {
  private readonly safeStorage: SafeStorageLike;
  private readonly filePath: string;
  private cache: StoredCredential | undefined;

  constructor(safeStorage: SafeStorageLike, filePath: string) {
    this.safeStorage = safeStorage;
    this.filePath = filePath;
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
  }

  private load(): StoredCredential {
    if (this.cache) return this.cache;
    if (!existsSync(this.filePath)) {
      this.cache = {};
      return this.cache;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
      this.cache = parsed && typeof parsed === "object" ? (parsed as StoredCredential) : {};
    } catch {
      // An unreadable credential file is treated as empty rather than fatal:
      // the user re-enters the key. It is never treated as an excuse to store
      // plaintext.
      this.cache = {};
    }
    return this.cache;
  }

  private flush(): void {
    writeFileSync(this.filePath, JSON.stringify(this.cache ?? {}, null, 2), "utf8");
  }

  has(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.load(), name);
  }

  resolve(name: string): string | null {
    if (!this.safeStorage.isEncryptionAvailable()) return null;
    const blob = this.load()[name];
    if (typeof blob !== "string" || blob.length === 0) return null;
    try {
      return this.safeStorage.decryptString(Buffer.from(blob, "base64"));
    } catch {
      // A value that cannot be decrypted is not a value we can use.
      return null;
    }
  }

  resolveRequired(name: string): string {
    const value = this.resolve(name);
    if (value === null) {
      throw new CredentialUnavailableError(name);
    }
    return value;
  }

  set(name: string, value: string): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error(
        "OS secure storage is unavailable; refusing to store a credential in plaintext",
      );
    }
    const next = { ...this.load(), [name]: this.safeStorage.encryptString(value).toString("base64") };
    this.cache = next;
    this.flush();
  }

  delete(name: string): void {
    if (!this.has(name)) return;
    const next = { ...this.load() };
    delete next[name];
    this.cache = next;
    this.flush();
  }

  listNames(): readonly string[] {
    return Object.keys(this.load()).sort();
  }
}
