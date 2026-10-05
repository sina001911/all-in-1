/**
 * In-memory credential provider (D1).
 *
 * Used by tests and by the headless self-test, where no OS keyring is present.
 * It implements the same contract as the safe-storage provider so behaviour is
 * identical apart from the backing store.
 */
import type { CredentialProvider } from "./types.ts";
import { CredentialUnavailableError } from "./types.ts";

export class MemoryCredentialProvider implements CredentialProvider {
  private readonly store = new Map<string, string>();

  has(name: string): boolean {
    return this.store.has(name);
  }
  resolve(name: string): string | null {
    return this.store.get(name) ?? null;
  }
  resolveRequired(name: string): string {
    const value = this.resolve(name);
    if (value === null) throw new CredentialUnavailableError(name);
    return value;
  }
  set(name: string, value: string): void {
    this.store.set(name, value);
  }
  delete(name: string): void {
    this.store.delete(name);
  }
  listNames(): readonly string[] {
    return [...this.store.keys()].sort();
  }
}
