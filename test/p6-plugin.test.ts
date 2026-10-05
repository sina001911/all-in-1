/**
 * P6 plugin binding test suite.
 *
 * Pins the three things P6 added:
 *   1. the ambient SDK contract is the verified surface and type-checks with no
 *      package present;
 *   2. the command surface routes through the engine and enforces the mode
 *      guards, including the P6 edit boundary;
 *   3. the package stays inert: no file writes, no npm dependencies, no
 *      credential, autonomy bounded.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCommandPrompt } from "../src/plugin/prompt.ts";
import { assertEditPlanAllowed, editPlanDisclaimer } from "../src/plugin/plan-gate.ts";
import { executePluginCommand } from "../src/plugin/execute.ts";
import {
  allInOneCommandDefinitions,
  COMMAND_IDS,
  registerAllInOneCommands,
  type CommandDefinitionLike,
  type CommandInvocationLike,
  type Deliver,
  type DeliverInput,
  type PluginCommandContext,
} from "../src/plugin/commands.ts";
import { ModeViolationError } from "../src/safety/guard.ts";
import { buildSpecialistStack } from "../src/specialists/stack.ts";
import pkgJson from "../package.json" with { type: "json" };

const pkg = pkgJson as { dependencies?: Record<string, string> };

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    const full = join(ROOT, dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTs(join(dir, entry)));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("prompt parsing", () => {
  it("collects the subject from plain text", () => {
    const r = parseCommandPrompt("review the auth module");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.subject).toBe("review the auth module");
    expect(r.auto).toBe(false);
    expect(r.steps).toBe(null);
    expect(r.plan).toBe(null);
  });

  it("extracts --auto without consuming it as a subject", () => {
    const r = parseCommandPrompt("fix the bug --auto");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.subject).toBe("fix the bug");
    expect(r.auto).toBe(true);
  });

  it("parses --steps into roles in order", () => {
    const r = parseCommandPrompt("x --steps CODE_REVIEWER,DEEP_REASONING");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.steps).toEqual(["CODE_REVIEWER", "DEEP_REASONING"]);
  });

  it("rejects an unknown role rather than silently misrouting", () => {
    const r = parseCommandPrompt("x --steps NOT_A_REAL_ROLE");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("COMMAND_PARSE");
    expect(r.error.message).toContain("NOT_A_REAL_ROLE");
  });

  it("treats an unknown flag as an error, not subject text", () => {
    const r = parseCommandPrompt("fix --audo the bug");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("--audo");
  });

  it("supports --plan and --no-plan overrides", () => {
    expect(parseCommandPrompt("x --plan")).toMatchObject({ ok: true, plan: true });
    expect(parseCommandPrompt("x --no-plan")).toMatchObject({ ok: true, plan: false });
  });

  it("parses an empty prompt to an empty subject", () => {
    expect(parseCommandPrompt("   ")).toMatchObject({ ok: true, subject: "" });
  });
});

describe("the P6 edit boundary", () => {
  it("refuses an edit-capable plan in INSPECT", () => {
    expect(() => assertEditPlanAllowed("INSPECT")).toThrow(ModeViolationError);
  });

  it("refuses an edit-capable plan in SUGGEST", () => {
    expect(() => assertEditPlanAllowed("SUGGEST")).toThrow(ModeViolationError);
  });

  it("allows one only in BUILD", () => {
    expect(() => assertEditPlanAllowed("BUILD")).not.toThrow();
  });

  it("states that only the OpenCode tools write", () => {
    const text = editPlanDisclaimer();
    expect(text).toContain("never writes files");
    expect(text).toContain("OpenCode write/edit/patch tools");
    expect(text).toContain("human supervision");
  });
});

describe("command execution routes through the engine", () => {
  const stack = buildSpecialistStack();

  it("INSPECT analyzes and carries no plan", async () => {
    const r = await executePluginCommand(
      { mode: "INSPECT", subject: "the login flow", steps: null, plan: null, auto: false, specialistId: null },
      stack,
    );
    expect(r.ok).toBe(true);
    expect(r.mode).toBe("INSPECT");
    expect(r.text).toContain("the login flow");
    expect(r.text).toContain("analyze only, no edits");
    expect(r.text).not.toContain("editPlanDisclaimer");
  });

  it("SUGGEST produces a plan but still no edit surface", async () => {
    const r = await executePluginCommand(
      { mode: "SUGGEST", subject: "the login flow", steps: null, plan: null, auto: false, specialistId: null },
      stack,
    );
    expect(r.ok).toBe(true);
    expect(r.text).toContain("plan:");
    expect(r.text).not.toContain("never writes files");
  });

  it("refuses an explicitly requested plan in INSPECT (no plan permission)", async () => {
    const r = await executePluginCommand(
      { mode: "INSPECT", subject: "the login flow", steps: null, plan: true, auto: false, specialistId: null },
      stack,
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("MODE_VIOLATION");
    expect(r.text).toContain("refused");
  });

  it("BUILD attaches the edit disclaimer naming the OpenCode tools", async () => {
    const r = await executePluginCommand(
      { mode: "BUILD", subject: "the login flow", steps: null, plan: null, auto: false, specialistId: null },
      stack,
    );
    expect(r.ok).toBe(true);
    expect(r.text).toContain("never writes files");
    expect(r.text).toContain("OpenCode write/edit/patch tools");
  });

  it("honours an explicit --steps override", async () => {
    const r = await executePluginCommand(
      {
        mode: "INSPECT",
        subject: "x",
        steps: ["FAST_TASK"],
        plan: null,
        auto: false,
        specialistId: null,
      },
      stack,
    );
    expect(r.ok).toBe(true);
    expect(r.text).toContain("[FAST_TASK]");
  });

  it("reports an unknown specialist id rather than inventing one", async () => {
    const r = await executePluginCommand(
      {
        mode: "INSPECT",
        subject: "x",
        steps: null,
        plan: null,
        auto: false,
        specialistId: "does-not-exist",
      },
      stack,
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("SPECIALIST_NOT_FOUND");
    expect(r.text).toContain("Available:");
  });

  it("runs a registered specialist", async () => {
    const r = await executePluginCommand(
      {
        mode: "INSPECT",
        subject: "check the handler",
        steps: null,
        plan: null,
        auto: false,
        specialistId: "code-review",
      },
      stack,
    );
    expect(r.ok).toBe(true);
    expect(r.text).toContain("code-review");
    expect(r.text).toContain("CODE_REVIEWER");
  });

  it("caps --auto iteration at the frozen limit", async () => {
    const r = await executePluginCommand(
      {
        mode: "BUILD",
        subject: "x",
        steps: ["CODE_REVIEWER", "DEEP_REASONING", "CODING_ASSISTANT", "FAST_TASK", "CODE_REVIEWER", "DEEP_REASONING"],
        plan: null,
        auto: true,
        specialistId: null,
      },
      stack,
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("WORKFLOW_AUTO_LIMIT");
  });
});

describe("the command surface", () => {
  function capture(): { deliver: Deliver; inputs: DeliverInput[] } {
    const inputs: DeliverInput[] = [];
    return {
      inputs,
      deliver: async (input) => {
        inputs.push(input);
      },
    };
  }

  function invoke(def: CommandDefinitionLike, text: string): Promise<void> {
    const invocation: CommandInvocationLike = {
      sessionID: "sess-1",
      prompt: { text },
      delivery: "steer",
    };
    return def.execute(invocation);
  }

  const defs = () => allInOneCommandDefinitions(capture().deliver);

  it("registers exactly the expected command ids", () => {
    expect(defs().map((d) => d.name)).toEqual([...COMMAND_IDS]);
  });

  it("delivers an analysis for the inspect command", async () => {
    const c = capture();
    const def = allInOneCommandDefinitions(c.deliver).find((d) => d.name === "all-in-1-inspect");
    expect(def).toBeDefined();
    if (!def) return;
    await invoke(def, "the retry policy");
    expect(c.inputs).toHaveLength(1);
    expect(c.inputs[0]?.sessionID).toBe("sess-1");
    expect(c.inputs[0]?.delivery).toBe("steer");
    expect(c.inputs[0]?.text).toContain("the retry policy");
    expect(c.inputs[0]?.text).toContain("INSPECT");
  });

  it("delivers the frozen defaults for the policy command", async () => {
    const c = capture();
    const def = allInOneCommandDefinitions(c.deliver).find((d) => d.name === "all-in-1-policy");
    expect(def).toBeDefined();
    if (!def) return;
    await invoke(def, "");
    expect(c.inputs[0]?.text).toContain("spendBudgetUsd: 0");
    expect(c.inputs[0]?.text).toContain("FREE_ONLY");
    expect(c.inputs[0]?.text).toContain("The only file writers are the OpenCode tools");
    expect(c.inputs[0]?.text).toContain("runtime dependencies: zero");
  });

  it("routes the first token of the specialist command to a specialist id", async () => {
    const c = capture();
    const def = allInOneCommandDefinitions(c.deliver).find((d) => d.name === "all-in-1-specialist");
    expect(def).toBeDefined();
    if (!def) return;
    await invoke(def, "code-review the handler");
    expect(c.inputs[0]?.text).toContain("code-review");
  });

  it("delivers a parse error instead of running a bad command", async () => {
    const c = capture();
    const def = allInOneCommandDefinitions(c.deliver).find((d) => d.name === "all-in-1-inspect");
    expect(def).toBeDefined();
    if (!def) return;
    await invoke(def, "x --steps NOPE");
    expect(c.inputs).toHaveLength(1);
    expect(c.inputs[0]?.text).toContain("command refused");
  });

  it("delivers a step failure instead of throwing it", async () => {
    const c = capture();
    const def = allInOneCommandDefinitions(c.deliver).find((d) => d.name === "all-in-1-inspect");
    expect(def).toBeDefined();
    if (!def) return;
    // MAIN_CODER is a valid role but has no registered specialist: the failure
    // must be delivered as text, never thrown out of the executor.
    await invoke(def, "x --steps MAIN_CODER");
    expect(c.inputs).toHaveLength(1);
    expect(c.inputs[0]?.text).toContain("SPECIALIST_NOT_FOUND");
  });
});

describe("registration against the SDK seam", () => {
  it("adds every command through the transform and returns a disposable registration", async () => {
    const added: string[] = [];
    const ctx: PluginCommandContext = {
      command: {
        async transform(callback) {
          callback({
            add(def) {
              added.push(def.name);
            },
          });
          return { async dispose() {} };
        },
      },
      session: { async prompt() {} },
    };
    const registration = await registerAllInOneCommands(ctx);
    expect(added).toEqual([...COMMAND_IDS]);
    expect(typeof registration.dispose).toBe("function");
  });
});

describe("the binding stays inert and dependency-free", () => {
  function sdkModules(): Array<{ rel: string; src: string }> {
    return listTs("src").map((f) => ({
      rel: f.replace(ROOT, "").replace(/\\/g, "/"),
      src: readFileSync(f, "utf8"),
    }));
  }

  it("imports the SDK at runtime through exactly one module with the verified specifier", () => {
    // A runtime import is an `import` that is NOT `import type`, tied to the
    // SDK specifier on the same line. The ambient declaration and the
    // type-only imports elsewhere are erased and impose no runtime resolution,
    // which is what keeps the package buildable without the package installed.
    const runtimeImporters = sdkModules()
      .filter((m) => !m.rel.endsWith(".d.ts"))
      .filter((m) =>
        m.src
          .split("\n")
          .some(
            (line) => /^[ \t]*import\s+(?!type\b)/.test(line) && /"@opencode\/plugin"/.test(line),
          ),
      )
      .map((m) => m.rel);
    expect(runtimeImporters).toEqual(["src/plugin/index.ts"]);
  });

  it("uses the SDK only as type-only imports everywhere else", () => {
    // The runtime-import test above already proves only index.ts resolves the
    // SDK at runtime; this pins which other modules reference it at all. Every
    // such reference is an `import type`, erased at build time.
    const referencing = sdkModules()
      .filter((m) => !m.rel.endsWith(".d.ts") && m.rel !== "src/plugin/index.ts")
      .filter((m) => /from\s+"@opencode\/plugin"/.test(m.src))
      .map((m) => m.rel);
    expect(referencing).toEqual(["src/plugin/commands.ts"]);
  });

  it("declares the ambient contract under the verified specifier", () => {
    const decl = read("src/opencode-plugin.d.ts");
    expect(decl).toContain('declare module "@opencode/plugin"');
    expect(decl).toContain("Plugin.define");
    expect(decl).toContain("CommandDomain");
    expect(decl).toContain("SessionDomain");
    // the pinned verified version, for drift control
    expect(decl).toContain("@opencode/plugin@2.0.22");
  });

  it("keeps zero npm dependencies", () => {
    expect(pkg.dependencies).toBeUndefined();
  });

  it("writes no file from anywhere in the plugin layer", () => {
    const offenders: string[] = [];
    for (const file of listTs("src/plugin")) {
      const src = readFileSync(file, "utf8");
      if (/(?:from\s+["']node:fs|writeFileSync|writeFile\(|appendFileSync|cpSync|rmSync|mkdirSync)/.test(src)) {
        offenders.push(file.replace(ROOT, ""));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("requests no credential and opens no egress by default", () => {
    const { stack } = buildSpecialistStack();
    expect(stack.egress.kind).toBe("deny-all");
    expect(stack.egress.allowlist).toEqual([]);
    expect(stack.budget.snapshot()).toEqual({ budgetUsd: 0, reservedUsd: 0, spentUsd: 0 });
  });
});
