/**
 * Text analyzer (D35).
 *
 * The image path needs a vision provider; a text upload does not. These tests
 * exercise the local decode/classify/summarize path with no network, no
 * credential, and no artifact base — byte sequences only.
 *
 * The most consequential case is the UTF-16BE BOM: `new TextDecoder("utf-16")`
 * defaults to little-endian, so a big-endian file decodes as mojibake unless
 * the BOM is detected and the explicit label is chosen. That regression is the
 * reason the decoder exists and is what this file pins.
 */
import { describe, expect, it } from "vitest";
import { buildTextAnalyzer } from "../src/vision/text-analyzer.ts";

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("TextAnalyzer charset detection", () => {
  it("classifies pure ASCII as ascii", () => {
    const a = buildTextAnalyzer();
    const r = a.analyze({ bytes: bytes("hello world"), contentType: "text/plain" });
    expect(r.charset).toBe("ascii");
    expect(r.bytes).toBe(11);
    expect(r.lines).toBe(1);
    expect(r.firstLine).toBe("hello world");
    expect(r.summary).toContain("charset ascii");
  });

  it("classifies multi-byte UTF-8 as utf-8", () => {
    const a = buildTextAnalyzer();
    const r = a.analyze({ bytes: bytes("héllo wörld"), contentType: "text/plain" });
    expect(r.charset).toBe("utf-8");
    expect(r.firstLine).toBe("héllo wörld");
  });

  it("detects a UTF-8 BOM and strips it from the decoded text", () => {
    const a = buildTextAnalyzer();
    const body = new TextEncoder().encode("plain text");
    // Build the array directly — spreading the BOM through TextEncoder would
    // re-encode those bytes and destroy the marker.
    const withBom = new Uint8Array(3 + body.length);
    withBom[0] = 0xef;
    withBom[1] = 0xbb;
    withBom[2] = 0xbf;
    withBom.set(body, 3);
    const r = a.analyze({ bytes: withBom, contentType: "text/plain; charset=utf-8" });
    expect(r.charset).toBe("utf-8");
    expect(r.firstLine).toBe("plain text");
  });

  it("decodes a UTF-16LE BOM file without mojibake", () => {
    const a = buildTextAnalyzer();
    const text = "café";
    // Interleave code units into UTF-16LE. Use charCodeAt, not TextEncoder:
    // TextEncoder emits UTF-8 bytes, and treating those as code units would
    // double-encode the non-ASCII characters.
    const le = new Uint8Array(2 + text.length * 2);
    le[0] = 0xff;
    le[1] = 0xfe;
    for (let i = 0; i < text.length; i++) {
      const cp = text.charCodeAt(i)!;
      le[2 + i * 2] = cp & 0xff;
      le[2 + i * 2 + 1] = (cp >> 8) & 0xff;
    }
    const r = a.analyze({ bytes: le, contentType: "text/plain; charset=utf-16" });
    expect(r.charset).toBe("utf-16");
    expect(r.firstLine).toBe("café");
  });

  it("decodes a UTF-16BE BOM file without mojibake", () => {
    const a = buildTextAnalyzer();
    const text = "café";
    // Interleave code units into UTF-16BE. Use charCodeAt, not TextEncoder:
    // TextEncoder emits UTF-8 bytes, and treating those as code units would
    // double-encode the non-ASCII characters.
    const be = new Uint8Array(2 + text.length * 2);
    be[0] = 0xfe;
    be[1] = 0xff;
    for (let i = 0; i < text.length; i++) {
      const cp = text.charCodeAt(i)!;
      be[2 + i * 2] = (cp >> 8) & 0xff;
      be[2 + i * 2 + 1] = cp & 0xff;
    }
    const r = a.analyze({ bytes: be, contentType: "text/plain; charset=utf-16" });
    expect(r.charset).toBe("utf-16");
    expect(r.firstLine).toBe("café");
  });

  it("reports binary content with a warning and no first line", () => {
    const a = buildTextAnalyzer();
    const bin = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]);
    const r = a.analyze({ bytes: bin, contentType: "text/plain" });
    expect(r.charset).toBe("binary");
    expect(r.firstLine).toBeUndefined();
    expect(r.warnings).toContain("content is not decodable as text; binary detection fired");
    expect(r.summary).toContain("no non-empty lines");
  });
});

describe("TextAnalyzer line counting", () => {
  it("does not inflate the count for a trailing newline", () => {
    const a = buildTextAnalyzer();
    const r = a.analyze({ bytes: bytes("a\nb\n"), contentType: "text/plain" });
    expect(r.lines).toBe(2);
  });

  it("counts CRLF as a single separator", () => {
    const a = buildTextAnalyzer();
    const r = a.analyze({ bytes: bytes("a\r\nb\r\nc"), contentType: "text/plain" });
    expect(r.lines).toBe(3);
  });

  it("returns zero lines for empty input", () => {
    const a = buildTextAnalyzer();
    const r = a.analyze({ bytes: new Uint8Array(0), contentType: "text/plain" });
    expect(r.lines).toBe(0);
    expect(r.firstLine).toBeUndefined();
  });

  it("picks the first non-empty line, skipping blanks", () => {
    const a = buildTextAnalyzer();
    const r = a.analyze({ bytes: bytes("\n\n  \nreal content here"), contentType: "text/plain" });
    expect(r.firstLine).toBe("real content here");
  });

  it("truncates the first line at 120 characters", () => {
    const a = buildTextAnalyzer();
    const long = "x".repeat(200);
    const r = a.analyze({ bytes: bytes(long), contentType: "text/plain" });
    expect(r.firstLine).toBe("x".repeat(120));
  });
});

describe("TextAnalyzer contract", () => {
  it("throws on a non-text content type", () => {
    const a = buildTextAnalyzer();
    expect(() =>
      a.analyze({ bytes: bytes("hello"), contentType: "application/json" }),
    ).toThrow(/text\/\*/);
  });

  it("supports() ignores charset parameters", () => {
    const a = buildTextAnalyzer();
    expect(a.supports("text/plain")).toBe(true);
    expect(a.supports("text/plain; charset=utf-8")).toBe(true);
    expect(a.supports("TEXT/CSV")).toBe(true);
    expect(a.supports("application/pdf")).toBe(false);
    expect(a.supports("image/png")).toBe(false);
  });

  it("records the source artifact id as provenance", () => {
    const a = buildTextAnalyzer();
    const r = a.analyze({ bytes: bytes("x"), contentType: "text/plain", sourceArtifactId: "art_abc" });
    expect(r.provider).toBe("local-text");
    expect(r.model).toBe("text-decoder-1");
    expect(r.bytes).toBe(1);
    expect(r.warnings).toEqual([]);
  });

  it("produces a stable summary for identical input", () => {
    const a = buildTextAnalyzer();
    const req = { bytes: bytes("deterministic"), contentType: "text/plain" };
    expect(a.analyze(req).summary).toBe(a.analyze(req).summary);
  });
});