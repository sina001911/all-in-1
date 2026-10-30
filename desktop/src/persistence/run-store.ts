/**
 * Run store (D1). Persists workflow/specialist run records across restarts.
 */
import type { RunRecord, RunStore } from "./types.ts";
import { JsonFileStore } from "./json-store.ts";

interface RunFile {
  readonly runs: readonly RunRecord[];
}

export class FileRunStore implements RunStore {
  private readonly file: JsonFileStore<RunFile>;
  private runs: RunRecord[] = [];

  constructor(file: JsonFileStore<RunFile>) {
    this.file = file;
    try {
      this.runs = [...(file.read()?.runs ?? [])];
    } catch (e) {
      // A corrupt run store is not fatal: the run history is a cache, not a
      // source of truth. Surface the error so the operator knows, and start
      // fresh rather than silently losing every past run.
      console.error("run store: starting fresh because the persisted file is unreadable", e);
      this.runs = [];
    }
  }

  record(run: RunRecord): void {
    this.runs = [...this.runs.filter((r) => r.id !== run.id), run];
  }

  update(id: string, patch: Partial<RunRecord>): void {
    const existing = this.runs.find((r) => r.id === id);
    if (!existing) return;
    this.runs = this.runs.map((r) => (r.id === id ? { ...r, ...patch } : r));
  }

  get(id: string): RunRecord | undefined {
    return this.runs.find((r) => r.id === id);
  }

  list(): readonly RunRecord[] {
    return [...this.runs].sort((a, b) => b.startedAt - a.startedAt);
  }

  rename(id: string, name: string): boolean {
    const existing = this.runs.find((r) => r.id === id);
    if (!existing) return false;
    this.runs = this.runs.map((r) => (r.id === id ? { ...r, name } : r));
    return true;
  }

  remove(id: string): boolean {
    const before = this.runs.length;
    this.runs = this.runs.filter((r) => r.id !== id);
    return this.runs.length !== before;
  }

  search(query: string): readonly RunRecord[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.list();
    return this.list().filter((r) =>
      r.subject.toLowerCase().includes(q) || (r.name ?? "").toLowerCase().includes(q),
    );
  }

  clear(): void {
    this.runs = [];
  }

  save(): void {
    this.file.write({ runs: this.runs });
  }
}

export class MemoryRunStore implements RunStore {
  private runs: RunRecord[] = [];

  record(run: RunRecord): void {
    this.runs = [...this.runs.filter((r) => r.id !== run.id), run];
  }
  update(id: string, patch: Partial<RunRecord>): void {
    const existing = this.runs.find((r) => r.id === id);
    if (!existing) return;
    this.runs = this.runs.map((r) => (r.id === id ? { ...r, ...patch } : r));
  }
  get(id: string): RunRecord | undefined {
    return this.runs.find((r) => r.id === id);
  }
  list(): readonly RunRecord[] {
    return [...this.runs].sort((a, b) => b.startedAt - a.startedAt);
  }
  rename(id: string, name: string): boolean {
    const existing = this.runs.find((r) => r.id === id);
    if (!existing) return false;
    this.runs = this.runs.map((r) => (r.id === id ? { ...r, name } : r));
    return true;
  }
  remove(id: string): boolean {
    const before = this.runs.length;
    this.runs = this.runs.filter((r) => r.id !== id);
    return this.runs.length !== before;
  }
  search(query: string): readonly RunRecord[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.list();
    return this.list().filter((r) =>
      r.subject.toLowerCase().includes(q) || (r.name ?? "").toLowerCase().includes(q),
    );
  }
  clear(): void {
    this.runs = [];
  }
  save(): void {
    /* in-memory: no-op */
  }
}
