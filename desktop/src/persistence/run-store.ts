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
    this.runs = [...(file.read()?.runs ?? [])];
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
  clear(): void {
    this.runs = [];
  }
  save(): void {
    /* in-memory: no-op */
  }
}
