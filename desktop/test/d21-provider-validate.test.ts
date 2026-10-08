/**
 * D21: provider config validation is a *capability check*, not persistence.
 * The UI must tell the user when a config would fail sanitization or fail the
 * authorization/reachability surface before save, without ever reading a key
 * value. Raw key never appears in the result detail.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { once } from "node:events";
import { buildDesktopStack } from "../src/desktop-stack.ts";
import { DesktopFacade } from "../src/facade.ts";
import { MemoryCredentialProvider } from "../src/credentials/memory-credential-provider.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-d21-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function startModelsServer(payload: object, status = 200): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return { port, stop: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("facade.testProviderConfig", () => {
  it("returns ok when the endpoint exposes all declared models", async () => {
    const server = await startModelsServer({ data: [{ id: "mini" }, { id: "other" }] });
    process.env.AIO_LOCAL_TEST_KEY = "present";
    const stack = buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
    const f = new DesktopFacade(stack);
    try {
      const result = await f.testProviderConfig({
        id: "localsrv",
        displayName: "Local server",
        endpoint: `http://127.0.0.1:${server.port}/v1`,
        apiKeyEnv: "AIO_LOCAL_TEST_KEY",
        models: [{ id: "mini" }],
      });
      expect(result.ok).toBe(true);
      expect(result.code).toBeUndefined();
      expect(result.models[0]!.discovered).toBe(true);
    } finally {
      delete process.env.AIO_LOCAL_TEST_KEY;
      await server.stop();
    }
  });

  it("rejects unsafe remote http config before probing", async () => {
    const stack = buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
    const f = new DesktopFacade(stack);
    const result = await f.testProviderConfig({
      id: "unsafe",
      displayName: "Unsafe",
      endpoint: "http://remote.example.com/v1",
      models: [{ id: "mini" }],
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("PROVIDER_INVALID");
  });

  it("flags a missing env var with code CREDENTIAL_UNAVAILABLE and does not probe", async () => {
    const stack = buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
    const f = new DesktopFacade(stack);
    const result = await f.testProviderConfig({
      id: "needskey",
      displayName: "Needs key",
      endpoint: "http://127.0.0.1:1/v1",
      apiKeyEnv: "AIO_TEST_MISSING_ENV",
      models: [{ id: "mini" }],
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("CREDENTIAL_UNAVAILABLE");
    expect(result.detail).toContain('AIO_TEST_MISSING_ENV');
  });

  it("surfaces a non-JSON response as PROVIDER_CALL_FAILED", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("not json");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const stack = buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
    const f = new DesktopFacade(stack);
    try {
      const result = await f.testProviderConfig({
        id: "localsrv",
        displayName: "Local",
        endpoint: `http://127.0.0.1:${port}/v1`,
        models: [{ id: "mini" }],
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe("PROVIDER_CALL_FAILED");
    } finally {
      server.close();
    }
  });

  it("reported models are all discovered if they are listed", async () => {
    const server = await startModelsServer({ data: [{ id: "mini" }, { id: "other" }] });
    const stack = buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
    const f = new DesktopFacade(stack);
    try {
      const result = await f.testProviderConfig({
        id: "localsrv",
        displayName: "Local",
        endpoint: `http://127.0.0.1:${server.port}/v1`,
        models: [{ id: "mini" }, { id: "other" }],
      });
      expect(result.ok).toBe(true);
      expect(result.models.every((m) => m.discovered)).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("report does not leak any secret value", async () => {
    process.env.AIO_LOCAL_TEST_KEY = "present";
    const stack = buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
    const f = new DesktopFacade(stack);
    try {
      const result = await f.testProviderConfig({
        id: "localsrv",
        displayName: "Local",
        endpoint: "https://api.example.com/v1",
        apiKeyEnv: "AIO_LOCAL_TEST_KEY",
        models: [{ id: "mini" }],
      });
      expect(result.detail).not.toContain("present");
    } finally {
      delete process.env.AIO_LOCAL_TEST_KEY;
    }
  });
});
