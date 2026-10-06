/**
 * Shared helpers for the file tools (D2).
 *
 * `readTextBounded` never reads more than the workspace's byte ceiling, so a
 * model cannot pull a multi-gigabyte file into context, and it truncates on a
 * UTF-8 character boundary rather than mid-sequence.
 *
 * `lineDiff` produces a minimal unified diff so `edit`/`patch` results show the
 * human what changed without pulling in a diff library.
 */
import { readFileSync, statSync } from "node:fs";
import { AllInOneError } from "../../errors.ts";

export interface BoundedRead {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

export function readTextBounded(path: string, maxBytes: number): BoundedRead {
  const size = statSync(path).size;
  if (size <= maxBytes) {
    return { text: readFileSync(path, "utf8"), bytes: size, truncated: false };
  }
  const buf = readFileSync(path);
  // Truncate on a complete UTF-8 sequence: walk back over any continuation
  // bytes, then back over an incomplete leading byte.
  let end = Math.min(maxBytes, buf.length);
  while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) end -= 1;
  if (end > 0) {
    const lead = buf[end - 1] as number;
    if ((lead & 0xe0) === 0xc0 && buf.length - (end - 1) < 2) end -= 1;
    else if ((lead & 0xf0) === 0xe0 && buf.length - (end - 1) < 3) end -= 1;
    else if ((lead & 0xf8) === 0xf0 && buf.length - (end - 1) < 4) end -= 1;
  }
  return { text: buf.subarray(0, end).toString("utf8"), bytes: size, truncated: true };
}

/** True when the buffer looks binary (a NUL byte in the head), so search skips it. */
export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 4096).includes(0);
}

interface Hunk {
  aStart: number;
  aLen: number;
  bStart: number;
  bLen: number;
  lines: string[];
}

/**
 * Minimal LCS-based unified diff over lines. Deliberately capped: oversized
 * inputs degrade to a single replace hunk so the diff cannot flood the result.
 */
export function lineDiff(beforePath: string, before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const hunks = diffHunks(a, b);
  if (hunks.length === 0) return "(no changes)";
  const out: string[] = [`--- ${beforePath}`, `+++ ${beforePath}`];
  for (const h of hunks) {
    out.push(`@@ -${h.aStart + 1},${h.aLen} +${h.bStart + 1},${h.bLen} @@`);
    for (const line of h.lines) out.push(line);
  }
  return capDiff(out.join("\n"));
}

function diffHunks(a: readonly string[], b: readonly string[]): Hunk[] {
  if (a.length * b.length > 4_000_000) {
    return [
      {
        aStart: 0,
        aLen: a.length,
        bStart: 0,
        bLen: b.length,
        lines: [...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`)],
      },
    ];
  }
  const m = a.length;
  const n = b.length;
  const table: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops: { kind: " " | "+" | "-"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i] as string });
      i += 1;
      j += 1;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      ops.push({ kind: "-", line: a[i] as string });
      i += 1;
    } else {
      ops.push({ kind: "+", line: b[j] as string });
      j += 1;
    }
  }
  while (i < m) ops.push({ kind: "-", line: a[i++] as string });
  while (j < n) ops.push({ kind: "+", line: b[j++] as string });

  // Group each run of changes into a hunk with one line of context per side.
  const hunks: Hunk[] = [];
  let index = 0;
  let aLine = 0; // 0-based line consumed so far in `a`
  let bLine = 0; // 0-based line consumed so far in `b`
  while (index < ops.length) {
    if (ops[index]?.kind === " ") {
      aLine += 1;
      bLine += 1;
      index += 1;
      continue;
    }
    const hunk: Hunk = { aStart: aLine, bStart: bLine, aLen: 0, bLen: 0, lines: [] };
    if (index > 0 && ops[index - 1]?.kind === " ") {
      const ctx = ops[index - 1] as { kind: " "; line: string };
      hunk.lines.push(` ${ctx.line}`);
      hunk.aLen += 1;
      hunk.bLen += 1;
      hunk.aStart = Math.max(0, aLine - 1);
      hunk.bStart = Math.max(0, bLine - 1);
    }
    while (index < ops.length && ops[index]?.kind !== " ") {
      const op = ops[index] as { kind: " " | "+" | "-"; line: string };
      hunk.lines.push(`${op.kind}${op.line}`);
      if (op.kind === "-") aLine += 1;
      if (op.kind === "+") bLine += 1;
      hunk.aLen += op.kind === "+" ? 0 : 1;
      hunk.bLen += op.kind === "-" ? 0 : 1;
      index += 1;
    }
    if (index < ops.length && ops[index]?.kind === " ") {
      const ctx = ops[index] as { kind: " "; line: string };
      hunk.lines.push(` ${ctx.line}`);
      hunk.aLen += 1;
      hunk.bLen += 1;
      aLine += 1;
      bLine += 1;
      index += 1;
    }
    hunks.push(hunk);
  }
  return hunks;
}

function capDiff(diff: string): string {
  const MAX = 8192;
  return diff.length > MAX ? `${diff.slice(0, MAX)}\n…(diff truncated)` : diff;
}

export function toolFailure(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message };
}

export function securityError(message: string): AllInOneError {
  return new AllInOneError(message, "PATH_TRAVERSAL_BLOCKED", "security");
}
