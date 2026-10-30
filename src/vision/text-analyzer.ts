/**
 * Text-file analysis (D35).
 *
 * The image path (P3) needs a vision provider. A text upload does not: it is
 * decoded locally, classified by MIME, and summarized with no network call and
 * no credential. This module owns that path so the artifact surface can answer
 * "what is this file?" for every content type the store accepts.
 *
 * It is intentionally small and deterministic:
 *   - binary detection is byte-level, so a UTF-16 file is not misread as text;
 *   - the summary is derived from verifiable properties (length, charset,
 *     line count, first non-empty line) — nothing is invented;
 *   - a file that is neither image nor text is reported as binary with a
 *     content-type hint, never analyzed.
 */
import { createHash } from "node:crypto";
import type { AllInOneError } from "../errors.ts";

export interface TextAnalysisRequest {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** Optional provenance, recorded for tracing. Never a secret. */
  readonly sourceArtifactId?: string;
}

export interface TextAnalysis {
  readonly provider: "local-text";
  readonly model: "text-decoder-1";
  readonly contentType: string;
  readonly charset: "utf-8" | "utf-16" | "ascii" | "binary";
  readonly bytes: number;
  readonly lines: number;
  readonly firstLine?: string;
  readonly summary: string;
  readonly warnings: readonly string[];
}

export interface TextAnalyzer {
  analyze(request: TextAnalysisRequest): TextAnalysis;
  /** True when the content type is a decodable text type. */
  supports(contentType: string): boolean;
}

const TEXT_MIME_PREFIXES = ["text/"];
const UTF16_LE_BOM = [0xff, 0xfe];
const UTF16_BE_BOM = [0xfe, 0xff];
const UTF8_BOM = [0xef, 0xbb, 0xbf];

/** Byte-level binary detection: control bytes other than CR/LF/tab/NUL. */
function isBinary(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b < 0x20) return true; // other control byte
    if (b === 0x7f) return true; // DEL
  }
  return false;
}

function detectCharset(bytes: Uint8Array): TextAnalysis["charset"] {
  if (bytes.length >= 2) {
    if (bytes[0] === UTF16_LE_BOM[0] && bytes[1] === UTF16_LE_BOM[1]) return "utf-16";
    if (bytes[0] === UTF16_BE_BOM[0] && bytes[1] === UTF16_BE_BOM[1]) return "utf-16";
  }
  if (bytes.length >= 3 && bytes[0] === UTF8_BOM[0] && bytes[1] === UTF8_BOM[1] && bytes[2] === UTF8_BOM[2]) {
    return "utf-8";
  }
  if (isBinary(bytes)) return "binary";
  // All printable ASCII or pure-ASCII UTF-8.
  let ascii = true;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i]! > 0x7f) { ascii = false; break; }
  }
  return ascii ? "ascii" : "utf-8";
}

function decode(bytes: Uint8Array, charset: TextAnalysis["charset"]): string {
  if (charset === "binary") return "";
  // `new TextDecoder("utf-16")` defaults to little-endian, so a big-endian BOM
  // file decodes as mojibake. Detect the BOM and pick the explicit label.
  const bomLen = charset === "utf-8" && bytes.length >= 3 &&
    bytes[0] === UTF8_BOM[0] && bytes[1] === UTF8_BOM[1] && bytes[2] === UTF8_BOM[2] ? 3
    : charset === "utf-16" ? 2 : 0;
  const slice = bytes.subarray(bomLen);
  let label: string;
  if (charset === "ascii") {
    label = "utf-8";
  } else if (charset === "utf-16") {
    label = bytes[0] === UTF16_BE_BOM[0] && bytes[1] === UTF16_BE_BOM[1] ? "utf-16be" : "utf-16le";
  } else {
    label = "utf-8";
  }
  try {
    return new TextDecoder(label).decode(slice);
  } catch {
    return new TextDecoder().decode(slice);
  }
}

function firstNonEmptyLine(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed.slice(0, 120);
  }
  return undefined;
}

export function buildTextAnalyzer(): TextAnalyzer {
  return {
    supports(contentType: string): boolean {
      return contentType.toLowerCase().split(";")[0]?.trim()?.startsWith("text/") ?? false;
    },
    analyze(request: TextAnalysisRequest): TextAnalysis {
      const ct = request.contentType.toLowerCase().split(";")[0]?.trim() ?? "";
      if (!ct.startsWith("text/")) {
        throw new Error(`text analysis requires a text/* content type, got ${request.contentType}`);
      }
      const charset = detectCharset(request.bytes);
      const warnings: string[] = [];
      if (charset === "binary") {
        warnings.push("content is not decodable as text; binary detection fired");
      }
      const text = decode(request.bytes, charset);
      // A trailing newline must not inflate the count: `"a\nb\n"` is two
      // lines, and `split(/\r?\n/)` on it yields `["a","b",""]` (three).
      const lines = text.length
        ? text.replace(/\r?\n$/, "").split(/\r?\n/).length
        : 0;
      const firstLine = firstNonEmptyLine(text);
      const hash = createHash("sha256").update(Buffer.from(request.bytes)).digest("hex").slice(0, 12);
      const summary = firstLine
        ? `${lines} line(s), ${request.bytes.length} bytes, charset ${charset}: "${firstLine}"`
        : `${request.bytes.length} bytes, charset ${charset}, no non-empty lines`;
      return {
        provider: "local-text",
        model: "text-decoder-1",
        contentType: request.contentType,
        charset,
        bytes: request.bytes.length,
        lines,
        firstLine,
        summary,
        warnings,
      };
    },
  };
}

export type { AllInOneError };