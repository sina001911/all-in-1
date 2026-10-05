#!/usr/bin/env node
/**
 * Standalone CLI — the zero-config fallback path. Drives the engine from any
 * project directory without any OpenCode configuration change.
 *
 * Usage (verified on Node 24.21.0):
 *   node src/cli.ts detect [path]
 *   node src/cli.ts resolve <role>
 *   node src/cli.ts policy
 *   node src/cli.ts shot <localhost-url>
 *   node src/cli.ts analyze <localhost-url>
 */
import { detectProject } from "./project/detector.ts";
import { AdapterRegistry } from "./project/registry.ts";
import { genericAdapter } from "./project/adapters/generic.ts";
import { staticAdapter } from "./project/adapters/static.ts";
import { viteAdapter } from "./project/adapters/vite.ts";
import { ModelRegistry } from "./registry/model.registry.ts";
import { ProviderRegistry } from "./registry/provider.registry.ts";
import { ModelRouter } from "./registry/model.router.ts";
import { ApprovalStore } from "./registry/approvals.ts";
import { BudgetLedger } from "./registry/budget.ts";
import { registerStubs } from "./registry/stub.ts";
import { PlaywrightEngine } from "./browser/playwright-adapter.ts";
import { ScreenshotEngine } from "./screenshot/engine.ts";
import { ArtifactStore } from "./artifacts/store.ts";
import { buildVisionStack } from "./vision/index.ts";
import { captureAndAnalyze } from "./vision/pipeline.ts";
import { toAllInOneError } from "./errors.ts";
import { ModelCatalog } from "./models/catalog.ts";
import { CapabilityRegistry } from "./capabilities/registry.ts";
import { registerBaselineCapabilities } from "./capabilities/capabilities.ts";
import { PriorityChains } from "./models/priorities.ts";
import { ExecutionEngine } from "./execution/engine.ts";
import { select } from "./execution/selector.ts";
import { buildExecutionStack } from "./execution/stack.ts";
import { buildSpecialistStack } from "./specialists/stack.ts";
import { WorkflowLoop } from "./workflow/index.ts";
import type { LogSink } from "./log/logger.ts";
import type { ModelRole } from "./registry/roles.ts";
import { resolve } from "node:path";
import { homedir } from "node:os";

function buildAdapterRegistry(): AdapterRegistry {
  const reg = new AdapterRegistry();
  reg.register(viteAdapter);
  reg.register(staticAdapter);
  reg.registerFallback(genericAdapter);
  return reg;
}

function buildModelRegistry(): ModelRegistry {
  const models = new ModelRegistry();
  registerStubs(models);
  return models;
}

/**
 * Structured JSONL to stderr so stdout stays machine-readable for scripting.
 * The logger itself redacts; the sink only decides where bytes go.
 */
function stderrLogSink(): LogSink {
  return {
    write(line: string): void {
      process.stderr.write(line + "\n");
    },
  };
}

/** Minimal `--flag value` / repeated-flag parser for the invoke command. */
class FlagBag {
  private readonly values = new Map<string, string[]>();
  get(name: string): string | undefined {
    return this.values.get(name)?.[0];
  }
  getAll(name: string): readonly string[] {
    return this.values.get(name) ?? [];
  }
  set(name: string, value: string): void {
    const existing = this.values.get(name) ?? [];
    existing.push(value);
    this.values.set(name, existing);
  }
}

function parseFlags(args: readonly string[]): FlagBag {
  const bag = new FlagBag();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        bag.set(name, next);
        i += 1;
      } else {
        bag.set(name, "true");
      }
    }
  }
  return bag;
}

/**
 * Parse an inline `--schema '{...}'` JSON value. An unreadable schema is
 * reported by the runner as a typed SCHEMA_INVALID failure rather than crashing
 * the CLI. With no flag an empty schema is used, which validates anything.
 */
function schemaFromFlag(raw: string | undefined): object {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as object;
  } catch {
    /* fall through: a non-empty unparseable value is still a schema attempt */
  }
  return { description: String(raw) };
}

async function main(): Promise<void> {
  const [, , cmd, ...args] = process.argv;

  if (cmd === "detect") {
    const root = resolve(args[0] ?? process.cwd());
    const reg = buildAdapterRegistry();
    const { adapter, detection } = detectProject(reg, root);
    console.log(
      JSON.stringify(
        {
          root,
          adapter: adapter.id,
          displayName: adapter.displayName,
          confidence: detection.confidence,
          ambiguous: detection.ambiguous,
          evidence: detection.evidence,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (cmd === "resolve") {
    const role = args[0];
    if (!role) {
      console.error(JSON.stringify({ ok: false, error: "role required" }));
      process.exitCode = 1;
      return;
    }
    const models = buildModelRegistry();
    const providers = new ProviderRegistry();
    const router = new ModelRouter({
      registry: models,
      approvals: new ApprovalStore(),
      budget: new BudgetLedger(0),
    });
    try {
      const decision = router.resolve({ role: role as never });
      console.log(JSON.stringify({ ok: true, decision }, null, 2));
    } catch (e) {
      console.error(
        JSON.stringify({ ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }),
      );
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === "shot") {
    const url = args[0];
    if (!url) {
      console.error(JSON.stringify({ ok: false, error: "url required" }));
      process.exitCode = 1;
      return;
    }
    const engine = new PlaywrightEngine({ hostPolicy: "localhost-only" });
    const store = new ArtifactStore({
      baseDir: resolve(homedir(), ".all-in-1", "artifacts"),
      retentionDays: 30,
      keepRuns: 5,
    });
    const shots = new ScreenshotEngine(engine, store);
    try {
      const outcome = await shots.capture({ url, runId: "cli" });
      console.log(
        JSON.stringify(
          {
            ok: true,
            artifactId: outcome.artifact.metadata.artifactId,
            path: outcome.artifact.path,
            bytes: outcome.bytes,
            title: outcome.title,
            sourceUrl: outcome.artifact.metadata.sourceUrl,
          },
          null,
          2,
        ),
      );
    } catch (e) {
      const typed = toAllInOneError(e, {
        code: "SCREENSHOT_FAILED",
        category: "browser",
        message: "capture failed",
      });
      console.error(
        JSON.stringify({ ok: false, error: `${typed.name}: ${typed.message}`, code: typed.code }),
      );
      process.exitCode = 1;
    } finally {
      await shots.close().catch(() => undefined);
    }
    return;
  }

  if (cmd === "analyze") {
    const url = args[0];
    if (!url) {
      console.error(JSON.stringify({ ok: false, error: "url required" }));
      process.exitCode = 1;
      return;
    }
    const artifacts = new ArtifactStore({
      baseDir: resolve(homedir(), ".all-in-1", "artifacts"),
      retentionDays: 30,
      keepRuns: 5,
    });
    const shots = new ScreenshotEngine(
      new PlaywrightEngine({ hostPolicy: "localhost-only" }),
      artifacts,
    );
    const stack = buildVisionStack(shots, artifacts, {
      maxImageEdge: 1568,
      locale: "fa",
    });
    try {
      const result = await captureAndAnalyze(shots, stack.analyzer, "fa", {
        url,
        runId: "cli",
      });
      console.log(
        JSON.stringify(
          {
            ok: result.analysis !== undefined,
            screenshot: {
              artifactId: result.screenshot.artifact.metadata.artifactId,
              path: result.screenshot.artifact.path,
              bytes: result.screenshot.bytes,
            },
            analysis: result.analysis ?? null,
            analyzerId: result.analyzerId ?? null,
            analysisError: result.analysisError
              ? `${result.analysisError.name}: ${result.analysisError.message}`
              : null,
          },
          null,
          2,
        ),
      );
      if (!result.analysis) process.exitCode = 1;
    } catch (e) {
      const typed = toAllInOneError(e, {
        code: "VISION_ANALYSIS_FAILED",
        category: "browser",
        message: "capture-and-analyze failed",
      });
      console.error(
        JSON.stringify({ ok: false, error: `${typed.name}: ${typed.message}`, code: typed.code }),
      );
      process.exitCode = 1;
    } finally {
      await shots.close().catch(() => undefined);
    }
    return;
  }

  if (cmd === "policy") {    console.log(
      JSON.stringify(
        {
          defaultPolicy: "FREE_ONLY",
          spendBudgetUsd: 0,
          unknownPricing: "blocked unless explicitly approved",
          silentPaidFallback: "forbidden",
          humanInTheLoop: "BUILD default",
          media: { enabled: false },
          mainCoder: { provider: "s1", model: "Atria-Dawn-Preview", fixed: true },
        },
        null,
        2,
      ),
    );
    return;
  }

  if (cmd === "select") {
    const capability = args[0];
    if (!capability) {
      console.error(JSON.stringify({ ok: false, error: "capability required" }));
      process.exitCode = 1;
      return;
    }
    const stack = buildExecutionStack({});
    try {
      const decision = select(
        { capability },
        {
          catalog: stack.catalog,
          capabilities: stack.capabilities,
          chains: stack.chains,
          approvals: stack.approvals,
          policy: "FREE_ONLY",
        },
      );
      console.log(JSON.stringify(decision, null, 2));
      if (!decision.ok) process.exitCode = 1;
    } catch (e) {
      console.error(
        JSON.stringify({
          ok: false,
          error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        }),
      );
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === "invoke") {
    const capability = args[0];
    if (!capability) {
      console.error(JSON.stringify({ ok: false, error: "capability required" }));
      process.exitCode = 1;
      return;
    }
    const flags = parseFlags(args.slice(1));
    const text = flags.get("text");
    const policy = (flags.get("policy") as "FREE_ONLY" | "PREMIUM_ALLOWED") ?? "FREE_ONLY";
    const budget = Number(flags.get("budget") ?? 0);
    // Hosts are allowlisted BEFORE the engine is built, so the egress policy
    // the engine holds is the policy it enforces.
    const stack = buildExecutionStack({
      policy,
      budgetUsd: Number.isFinite(budget) ? budget : 0,
      allowHosts: flags.getAll("allow-host"),
    });
    try {
      const outcome = await stack.engine.invoke({
        capability,
        inputs: text ? [{ kind: "text", text }] : [],
      });
      console.log(
        JSON.stringify(
          {
            ok: true,
            model: outcome.decision.model,
            basis: outcome.decision.basis,
            costClass: outcome.decision.costClass,
            adapter: outcome.adapterId,
            committedUsd: outcome.committedUsd,
            text: outcome.result.text,
            structured: outcome.result.structured ?? null,
            trace: outcome.decision.trace,
          },
          null,
          2,
        ),
      );
    } catch (e) {
      const typed = toAllInOneError(e, {
        code: "PROVIDER_CALL_FAILED",
        category: "unavailable",
        message: "invoke failed",
      });
      console.error(
        JSON.stringify({
          ok: false,
          error: `${typed.name}: ${typed.message}`,
          code: typed.code,
          category: typed.category,
        }),
      );
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === "specialist") {
    const role = args[0];
    if (!role) {
      console.error(JSON.stringify({ ok: false, error: "role required" }));
      process.exitCode = 1;
      return;
    }
    const flags = parseFlags(args.slice(1));
    const text = flags.get("text") ?? "";
    const image = flags.get("image");
    const policy = (flags.get("policy") as "FREE_ONLY" | "PREMIUM_ALLOWED") ?? "FREE_ONLY";
    const budget = Number(flags.get("budget") ?? 0);
    const { runner } = buildSpecialistStack({
      policy,
      budgetUsd: Number.isFinite(budget) ? budget : 0,
      logSink: stderrLogSink(),
    });
    const inputs: Array<{ kind: "text"; text: string } | { kind: "image"; artifactId: string }> = [];
    if (text) inputs.push({ kind: "text", text });
    if (image) inputs.push({ kind: "image", artifactId: image });
    try {
      const response = await runner.run({
        role: role as ModelRole,
        prompt: text,
        inputs,
        outputSchema: schemaFromFlag(flags.get("schema")),
      });
      console.log(JSON.stringify(response, null, 2));
      if (!response.ok) process.exitCode = 1;
    } catch (e) {
      console.error(
        JSON.stringify({
          ok: false,
          error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        }),
      );
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === "workflow") {
    const mode = args[0];
    if (mode !== "INSPECT" && mode !== "SUGGEST" && mode !== "BUILD") {
      console.error(JSON.stringify({ ok: false, error: "mode required: INSPECT | SUGGEST | BUILD" }));
      process.exitCode = 1;
      return;
    }
    const flags = parseFlags(args.slice(1));
    const stepsRaw = flags.get("steps") ?? "";
    const roles = stepsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (roles.length === 0) {
      console.error(JSON.stringify({ ok: false, error: "at least one step role required (--steps role,role)" }));
      process.exitCode = 1;
      return;
    }
    const text = flags.get("text") ?? "";
    const policy = (flags.get("policy") as "FREE_ONLY" | "PREMIUM_ALLOWED") ?? "FREE_ONLY";
    const budget = Number(flags.get("budget") ?? 0);
    const { runner } = buildSpecialistStack({
      policy,
      budgetUsd: Number.isFinite(budget) ? budget : 0,
      logSink: stderrLogSink(),
    });
    const autoFlag = flags.get("auto");
    const loop = new WorkflowLoop({
      runner,
      request: {
        mode,
        auto: autoFlag === "true" ? { auto: true } : undefined,
        plan: flags.get("plan") === "true",
        steps: roles.map((role) => ({
          role: role as ModelRole,
          prompt: text,
          inputs: text ? [{ kind: "text", text }] : [],
          outputSchema: {},
        })),
        timeoutMs: Number(flags.get("timeout")) || undefined,
      },
    });
    try {
      const result = await loop.run();
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok && !result.pausedForHuman) process.exitCode = 1;
    } catch (e) {
      console.error(
        JSON.stringify({
          ok: false,
          error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        }),
      );
      process.exitCode = 1;
    }
    return;
  }

  console.error(`Unknown command: ${cmd ?? "(none)"}`);
  console.error(
    "Available: detect [path] | resolve <role> | policy | shot <url> | analyze <localhost-url> | select <capability> | invoke <capability> [--text ...] [--allow-host host] | specialist <role> [--text ...] | workflow <mode> --steps role,role [--auto] [--plan]",
  );
  process.exitCode = 1;
}

void main();
