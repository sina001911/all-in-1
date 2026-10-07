/**
 * D14: the operator CLI shell for streaming.
 *
 * stdout remains final-machine-readable JSON, exactly like `invoke`; only
 * operator frames and skipped-stream telemetry go to stderr. The command is
 * an additive view; the engine path is the same one D11/D13 proves.
 */
import { describe, expect, it, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "src", "cli.ts");

function run(args: string[], timeoutMs = 15_000): { status: number; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return { status: proc.status ?? 1, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

async function startServer(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

describe("cli stream", () => {
  let closeServer: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (closeServer) {
      await closeServer();
      closeServer = undefined;
    }
  });

  it("buffering stdout final JSON while stderr carries the frames", () => {
    const result = run(["stream", "CODING", "--text", "hello operator", "--timeout", "5000"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("data: ");
    const payload = JSON.parse(result.stdout) as { ok: boolean; text: string; adapter: string };
    expect(payload.ok).toBe(true);
    expect(payload.adapter).toBe("local");
    expect(payload.text).toContain("hello operator");
  });

  it("invoke keeps the exact stdout contract and no data frames on stderr", () => {
    const result = run(["invoke", "CODING", "--text", "hello still buffered"]);
    expect(result.status).toBe(0);
    expect(result.stderr.trim()).toBe("");
    const payload = JSON.parse(result.stdout) as { ok: boolean; text: string; adapter: string };
    expect(payload.ok).toBe(true);
    expect(payload.adapter).toBe("local");
  });

  it("engine timeout surfaces typed error on stderr and exit 1", async () => {
    const HANG_HEADERS = { "content-type": "text/event-stream" };
    const server = http.createServer((_req, res) => {
      res.writeHead(200, HANG_HEADERS);
      res.write('data: {"choices":[{"delta":{"content":"alive"}}]}\n\n');
      // never complete the body: the engine timeout must cut it.
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    closeServer = async () => { server.close(); server.closeAllConnections?.(); };
    const port = (server.address() as { port: number }).port;

    const provider = JSON.stringify({
      id: "hung",
      displayName: "Hung",
      endpoint: `http://127.0.0.1:${port}/v1`,
      apiKeyEnv: null,
      models: [{ id: "mini", displayName: "Mini", capabilities: ["CHAT"], streaming: true }],
    });
    const result = run(["stream", "CHAT", "--text", "ping", "--timeout", "100", "--provider-json", provider]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("PROVIDER_TIMEOUT");
  });

  it("a typed provider error exits 1 and keeps stdout empty", async () => {
    const provider = JSON.stringify({
      id: "missing",
      displayName: "Missing",
      endpoint: "http://127.0.0.1:1/v1",
      apiKeyEnv: null,
      models: [{ id: "mini", displayName: "Mini", capabilities: ["CHAT"], streaming: true }],
    });
    const result = run(["stream", "CHAT", "--provider-json", provider, "--timeout", "500"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    const payload = JSON.parse(result.stderr.split("\n").filter((l) => l.startsWith("{")).reverse()[0] ?? "{}") as {
      ok: boolean;
      code?: string;
    };
    expect(payload.ok).toBe(false);
  });

  it("malformed --provider-json is reported rather than crash", () => {
    const result = run(["stream", "CODING", "--provider-json", "{bad"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--provider-json must be valid JSON");
  });

  it("help text includes the new sub-command", () => {
    const proc = spawnSync(process.execPath, [CLI], { cwd: ROOT, encoding: "utf8" });
    expect((proc.stderr ?? "") + (proc.stdout ?? "")).toContain("stream <capability>");
  });
});
