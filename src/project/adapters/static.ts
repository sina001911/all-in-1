/**
 * Static HTML/CSS/JS adapter. Detects a plain static site: index.html present,
 * no framework build config, no framework package markers.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ProjectAdapter, Detection, Inspection, CommandSpec, UrlSpec } from "../types.ts";

const FRAMEWORK_MARKERS = [
  "vite.config",
  "next.config",
  "nuxt.config",
  "vue.config",
  "angular.json",
  "svelte.config",
  "astro.config",
  "remix.config",
];

const STATIC_EXTENSIONS = new Set([".html", ".htm", ".css", ".js"]);

export const staticAdapter: ProjectAdapter = {
  id: "static",
  displayName: "Static HTML/CSS/JS",

  detect(root: string): Detection {
    const evidence: string[] = [];
    let confidence = 0;

    if (!existsSync(join(root, "index.html"))) {
      return {
        adapter: "static",
        confidence: 0,
        evidence: ["no index.html"],
        ambiguous: false,
        alternatives: [],
      };
    }
    evidence.push("index.html present");
    confidence = 0.75;

    const entries = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
    const hasFramework = entries.some((n) =>
      FRAMEWORK_MARKERS.some((m) => n.startsWith(m)),
    );
    if (hasFramework) {
      return {
        adapter: "static",
        confidence: 0.1,
        evidence: ["index.html present but framework config detected — deferring"],
        ambiguous: false,
        alternatives: [],
      };
    }
    evidence.push("no framework config markers");

    const hasPkg = entries.includes("package.json");
    if (hasPkg) {
      const pkg = tryReadJson(join(root, "package.json"));
      const deps = { ...(pkg?.dependencies as object), ...(pkg?.devDependencies as object) };
      const keys = Object.keys(deps);
      const frameworkDeps = keys.filter((k) =>
        ["vite", "next", "nuxt", "vue", "@angular/core", "svelte", "@astrojs", "@remix-run"].some((f) =>
          k === f || k.startsWith(`${f}/`),
        ),
      );
      if (frameworkDeps.length > 0) {
        return {
          adapter: "static",
          confidence: 0.1,
          evidence: [`framework deps present: ${frameworkDeps.join(", ")}`],
          ambiguous: false,
          alternatives: [],
        };
      }
      evidence.push("package.json without framework deps");
    }

    const staticFiles = entries.filter((n) => STATIC_EXTENSIONS.has(extOf(n)));
    if (staticFiles.length >= 2) evidence.push(`${staticFiles.length} static asset(s)`);

    return {
      adapter: "static",
      confidence,
      evidence,
      ambiguous: false,
      alternatives: [],
    };
  },

  inspect(root: string): Inspection {
    const html = tryRead(join(root, "index.html")) ?? "";
    const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
    return {
      framework: "static",
      entryFiles: ["index.html"],
      notes: [title ? `title: ${title}` : "no title", "no build step required"],
    };
  },

  getDevCommand(root: string): CommandSpec | null {
    void root;
    // No build pipeline to run; the browser layer serves the root statically (P2).
    return null;
  },

  getDevUrl(root: string): UrlSpec | null {
    void root;
    return { kind: "discovered", discovery: "port-scan" };
  },

  getBuildCommand(root: string): CommandSpec | null {
    void root;
    return null; // static sites have no build step
  },

  getTestCommand(root: string): CommandSpec | null {
    void root;
    return null;
  },

  getRelevantFiles(root: string): string[] {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isFile() && STATIC_EXTENSIONS.has(extOf(d.name)))
      .map((d) => join(root, d.name))
      .slice(0, 20);
  },

  routes: { default: "/" },
  capabilities: { needsAuth: false, hasSSR: false, dynamicRoutes: false },
};

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

function tryRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function tryReadJson(path: string): Record<string, unknown> | undefined {
  const raw = tryRead(path);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
