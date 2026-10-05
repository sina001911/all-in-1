/**
 * D1 credential tests.
 *
 * Proves the credential seam: values are stored encrypted, never returned
 * through a value-bearing method, and a missing credential fails loudly rather
 * than silently degrading to a keyless call.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ElectronSafeStorageCredentialProvider } from "../src/credentials/electron-safe-storage.ts";
import type { SafeStorageLike } from "../src/credentials/electron-safe-storage.ts";
import { MemoryCredentialProvider } from "../src/credentials/memory-credential-provider.ts";
import { CredentialUnavailableError } from "../src/credentials/types.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-cred-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A deterministic stand-in for Electron's DPAPI-backed safeStorage. */
class FakeSafeStorage implements SafeStorageLike {
  public encrypted: string[] = [];
  isEncryptionAvailable(): boolean {
    return true;
  }
  encryptString(plain: string): Buffer {
    const blob = `enc:${plain}`;
    this.encrypted.push(blob);
    return Buffer.from(blob, "utf8");
  }
  decryptString(encrypted: Buffer): string {
    const blob = encrypted.toString("utf8");
    if (!blob.startsWith("enc:")) throw new Error("not encrypted");
    return blob.slice(4);
  }
}

describe("safe-storage credential provider", () => {
  it("stores and resolves a value", () => {
    const safe = new FakeSafeStorage();
    const provider = new ElectronSafeStorageCredentialProvider(
      safe,
      join(dir, "credentials.json"),
    );
    provider.set("OPENROUTER_API_KEY", "sk-secret-123");
    expect(provider.has("OPENROUTER_API_KEY")).toBe(true);
    expect(provider.resolve("OPENROUTER_API_KEY")).toBe("sk-secret-123");
  });

  it("never writes the plaintext value to disk", () => {
    const safe = new FakeSafeStorage();
    const file = join(dir, "credentials.json");
    const provider = new ElectronSafeStorageCredentialProvider(safe, file);
    provider.set("OPENROUTER_API_KEY", "sk-secret-123");
    const onDisk = readFileSync(file, "utf8");
    // The plaintext secret must never appear in the stored file.
    expect(onDisk).not.toContain("sk-secret-123");
    // And the stored blob must be the base64 of the encrypted form only:
    // decode it round-trip to prove it carries the ciphertext, not the key.
    const stored = JSON.parse(onDisk) as Record<string, string>;
    const decoded = Buffer.from(stored["OPENROUTER_API_KEY"] ?? "", "base64").toString("utf8");
    expect(decoded).toBe("enc:sk-secret-123");
  });

  it("resolves null for a missing credential rather than throwing silently", () => {
    const provider = new ElectronSafeStorageCredentialProvider(
      new FakeSafeStorage(),
      join(dir, "credentials.json"),
    );
    expect(provider.resolve("NOT_SET")).toBe(null);
    expect(provider.has("NOT_SET")).toBe(false);
  });

  it("throws a typed error from resolveRequired", () => {
    const provider = new ElectronSafeStorageCredentialProvider(
      new FakeSafeStorage(),
      join(dir, "credentials.json"),
    );
    expect(() => provider.resolveRequired("NOT_SET")).toThrow(CredentialUnavailableError);
  });

  it("deletes a credential", () => {
    const provider = new ElectronSafeStorageCredentialProvider(
      new FakeSafeStorage(),
      join(dir, "credentials.json"),
    );
    provider.set("K", "v");
    provider.delete("K");
    expect(provider.has("K")).toBe(false);
  });

  it("lists names but never values", () => {
    const provider = new ElectronSafeStorageCredentialProvider(
      new FakeSafeStorage(),
      join(dir, "credentials.json"),
    );
    provider.set("B_KEY", "vb");
    provider.set("A_KEY", "va");
    expect(provider.listNames()).toEqual(["A_KEY", "B_KEY"]);
  });

  it("refuses to store in plaintext when encryption is unavailable", () => {
    const unavailable: SafeStorageLike = {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => "",
    };
    const provider = new ElectronSafeStorageCredentialProvider(
      unavailable,
      join(dir, "credentials.json"),
    );
    expect(() => provider.set("K", "v")).toThrow(/plaintext/);
  });

  it("treats an undecryptable value as absent, never as an excuse to store plaintext", () => {
    const safe = new FakeSafeStorage();
    const provider = new ElectronSafeStorageCredentialProvider(safe, join(dir, "credentials.json"));
    provider.set("K", "v");
    // Corrupt the file with a value the fake cannot decrypt.
    const broken: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (p) => Buffer.from(`enc:${p}`),
      decryptString: () => {
        throw new Error("corrupt");
      },
    };
    const reopened = new ElectronSafeStorageCredentialProvider(broken, join(dir, "credentials.json"));
    expect(reopened.resolve("K")).toBe(null);
  });
});

describe("memory credential provider", () => {
  it("implements the same contract", () => {
    const provider = new MemoryCredentialProvider();
    provider.set("K", "v");
    expect(provider.has("K")).toBe(true);
    expect(provider.resolve("K")).toBe("v");
    expect(provider.resolveRequired("K")).toBe("v");
    provider.delete("K");
    expect(() => provider.resolveRequired("K")).toThrow(CredentialUnavailableError);
  });
});
