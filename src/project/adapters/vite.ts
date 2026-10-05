/**
 * Vite adapter (React/Vue personality is a *property*, not a separate engine).
 * Package manager is detected from the lockfile, dev URL from config hints or
 * stdout, with port-scan as the fallback discovery path.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ProjectAdapter, Detection, Inspection, CommandSpec, UrlSpec, FeedbackIntent } from "../types.ts";

const VITE_CONFIGS = ["vite.config.js", "vite.config.mjs", "vite.config.ts", "vite.config.mts", "vite.config.cjs"];

const FRAMEWORK_HINTS: Record<string, string> = {
  react: "react",
  "react-dom": "react",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
};

export const viteAdapter: ProjectAdapter = {
  id: "vite",
  displayName: "Vite",

  detect(root: string): Detection {
    const evidence: string[] = [];
    let confidence = 0;

    const entries = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
    const config = VITE_CONFIGS.find((c) => entries.includes(c));

    if (!config) {
      return {
        adapter: "vite",
        confidence: 0,
        evidence: ["no vite.config.*"],
        ambiguous: false,
        alternatives: [],
      };
    }
    evidence.push(`${config} present`);
    confidence = 0.6;

    const pkg = tryReadJson(join(root, "package.json"));
    if (pkg) {
      evidence.push("package.json present");
      const deps = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) };
      const keys = Object.keys(deps);
      if (keys.includes("vite")) {
        evidence.push("vite in dependencies");
        confidence = Math.min(0.95, confidence + 0.2);
      }
      const personality = keys.find((k) => FRAMEWORK_HINTS[k]);
      if (personality) evidence.push(`personality: ${FRAMEWORK_HINTS[personality]}`);
      const devScript = (pkg.scripts as Record<string, string> | undefined)?.dev;
      if (devScript) evidence.push(`dev script: ${devScript}`);
    }

    if (existsSync(join(root, "index.html"))) {
      evidence.push("index.html present (Vite entry)");
      confidence = Math.min(0.95, confidence + 0.05);
    }

    return {
      adapter: "vite",
      confidence,
      evidence,
      ambiguous: false,
      alternatives: [],
    };
  },

  inspect(root: string): Inspection {
    const pkg = tryReadJson(join(root, "package.json"));
    const version = (pkg?.devDependencies as Record<string, string> | undefined)?.vite ??
      (pkg?.dependencies as Record<string, string> | undefined)?.vite;
    const deps = { ...(pkg?.dependencies as object), ...(pkg?.devDependencies as object) };
    const keys = Object.keys(deps);
    const personality = keys.find((k) => FRAMEWORK_HINTS[k]);
    return {
      framework: personality ? `vite/${FRAMEWORK_HINTS[personality]}` : "vite",
      version,
      entryFiles: ["index.html", "src/main.tsx", "src/main.ts"].filter((f) => existsSync(join(root, f))),
      notes: [
        `dev script: ${(pkg?.scripts as Record<string, string> | undefined)?.dev ?? "none"}`,
        `package manager: ${detectPackageManager(root)}`,
      ],
    };
  },

  getDevCommand(root: string): CommandSpec | null {
    const pm = detectPackageManager(root);
    const pkg = tryReadJson(join(root, "package.json"));
    const hasDevScript = !!((pkg?.scripts as Record<string, string> | undefined)?.dev);
    if (!hasDevScript) return null;
    const command = pm;
    return {
      command,
      args: ["run", "dev"],
      cwd: root,
      readyPattern: "Local:\\s+http://localhost:\\d+",
      port: 5173,
    };
  },

  getDevUrl(root: string): UrlSpec | null {
    void root;
    return { kind: "discovered", discovery: "stdout" };
  },

  getBuildCommand(root: string): CommandSpec | null {
    const pm = detectPackageManager(root);
    const pkg = tryReadJson(join(root, "package.json"));
    if (!((pkg?.scripts as Record<string, string> | undefined)?.build)) return null;
    return {
      command: pm,
      args: ["run", "build"],
      cwd: root,
    };
  },

  getTestCommand(root: string): CommandSpec | null {
    const pm = detectPackageManager(root);
    const pkg = tryReadJson(join(root, "package.json"));
    const scripts = pkg?.scripts as Record<string, string> | undefined;
    if (!scripts?.test && !scripts?.["test:unit"]) return null;
    return {
      command: pm,
      args: ["run", scripts.test ? "test" : "test:unit"],
      cwd: root,
    };
  },

  getRelevantFiles(root: string, intent?: FeedbackIntent): string[] {
    const base = ["index.html", "package.json", "vite.config.ts", "vite.config.js", "vite.config.mjs"];
    const src = ["src/main.tsx", "src/main.ts", "src/App.tsx", "src/App.vue", "src/index.css", "src/style.css"];
    const files = [...base, ...src].filter((f) => existsSync(join(root, f)));
    if (intent?.section) {
      const guess = `src/${intent.section}.tsx`;
      if (existsSync(join(root, guess))) files.unshift(guess);
    }
    return files.slice(0, 12);
  },

  routes: { default: "/" },
  capabilities: { needsAuth: false, hasSSR: false, dynamicRoutes: true },
};

export function detectPackageManager(root: string): "npm" | "pnpm" | "yarn" | "bun" {
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name);
  if (entries.includes("pnpm-lock.yaml")) return "pnpm";
  if (entries.includes("yarn.lock")) return "yarn";
  if (entries.includes("bun.lockb") || entries.includes("bun.lock")) return "bun";
  return "npm";
}

function tryReadJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
