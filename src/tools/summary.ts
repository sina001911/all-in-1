/**
 * Request summarization (D2).
 *
 * Builds the human-facing and audit-facing summary of a tool request. It is the
 * ONLY transformer between raw input and what gets recorded or shown for
 * approval, which is how two guarantees are kept:
 *
 *   - file CONTENTS are never summarized into the audit or the approval prompt;
 *     a `write` tool's content becomes "N bytes", not the bytes themselves.
 *   - no input field is assumed safe: long strings are truncated, unknown
 *     shapes are stringified and capped.
 */
import type { ToolSchema } from "./types.ts";

const MAX_FIELD = 240;
const MAX_SUMMARY = 400;

export function summarizeInput(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { input: cap(String(input)) };
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[key] = summarizeValue(key, value);
  }
  return out;
}

function summarizeValue(key: string, value: unknown): unknown {
  if (typeof value === "string") {
    // A write/edit body is NEVER recorded, at any length: the audit and the
    // approval prompt carry sizes and targets, never the bytes themselves.
    if (key === "content" || key === "newString" || key === "oldString" || key === "text") {
      return `${value.length} characters`;
    }
    return cap(value);
  }
  if (Array.isArray(value)) {
    return value.length > 12 ? `${value.length} items (truncated)` : value.map((v) => summarizeValue(key, v));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 12) return `${entries.length} properties (truncated)`;
    return Object.fromEntries(entries.map(([k, v]) => [k, summarizeValue(k, v)]));
  }
  return value;
}

function cap(s: string): string {
  return s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD)}…(${s.length} chars)` : s;
}

export function capSummary(s: string): string {
  return s.length > MAX_SUMMARY ? `${s.slice(0, MAX_SUMMARY)}…` : s;
}
