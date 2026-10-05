/**
 * Generic adapter — the ultimate fallback. Assumes a static-ish web root and
 * never claims a framework it cannot prove. Guarantees *some* adapter resolves
 * for every project, so detection can never fail outright.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ProjectAdapter, Detection, Inspection, CommandSpec, UrlSpec } from "../types.ts";

const SOURCE_EXTENSIONS = new Set([".html", ".htm", ".css", ".js", ".ts", ".jsx", ".tsx", ".vue", ".php", ".scss"]);

export const genericAdapter: ProjectAdapter = {
  id: "generic",
  displayName: "Generic Web Project",

  detect(root: string): Detection {
    const evidence: string[] = [];
    let confidence = 0.2; // low: fallback only
    if (existsSync(join(root, "index.html"))) {
      evidence.push("index.html present");
      confidence = 0.35;
    }
    const entries = listDir(root);
    const anySource = entries.some((e) => SOURCE_EXTENSIONS.has(extOf(e)));
    if (anySource) {
      evidence.push("web source files present");
      confidence = Math.min(0.45, confidence + 0.1);
    }
    return {
      adapter: "generic",
      confidence,
      evidence: evidence.length ? evidence : ["no framework markers detected"],
      ambiguous: false,
      alternatives: [],
    };
  },

  inspect(root: string): Inspection {
    const entries = listDir(root).filter((e) => SOURCE_EXTENSIONS.has(extOf(e)));
    return {
      framework: "generic",
      entryFiles: entries.slice(0, 8),
      notes: ["No specific framework detected; serving as static web root"],
    };
  },

  getDevCommand(root: string): CommandSpec | null {
    // No build pipeline assumed; the engine may serve the root statically.
    void root;
    return null;
  },

  getDevUrl(root: string): UrlSpec | null {
    void root;
    return { kind: "discovered", discovery: "port-scan" };
  },

  getBuildCommand(root: string): CommandSpec | null {
    void root;
    return null;
  },

  getTestCommand(root: string): CommandSpec | null {
    void root;
    return null;
  },

  getRelevantFiles(root: string): string[] {
    return listDir(root)
      .filter((e) => SOURCE_EXTENSIONS.has(extOf(e)))
      .slice(0, 20)
      .map((e) => join(root, e));
  },

  capabilities: { needsAuth: false, hasSSR: false, dynamicRoutes: false },
};

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((e) => {
      try {
        return statSync(join(dir, e)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}
