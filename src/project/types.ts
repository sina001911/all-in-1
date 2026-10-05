/**
 * Project adapter contract. Framework-specific behavior lives behind this
 * interface; the core never imports a framework directly. Every method is
 * side-effect free (the engine runs commands, adapters only describe them).
 */
export interface CommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Record<string, string>;
  /** Regex the engine waits for on stdout before considering the server ready. */
  readonly readyPattern?: string;
  readonly port?: number;
}

export interface UrlSpec {
  readonly kind: "fixed" | "discovered";
  readonly url?: string;
  readonly discovery?: "stdout" | "port-scan" | "config";
}

export interface RoutePreset {
  readonly path: string;
  readonly label: string;
}

export interface AdapterCapabilities {
  readonly needsAuth: boolean;
  readonly hasSSR: boolean;
  readonly dynamicRoutes: boolean;
}

export type FeedbackIntent = {
  readonly section?: string;
  readonly category?: string;
};

export interface Detection {
  readonly adapter: string;
  readonly confidence: number; // 0..1
  readonly evidence: readonly string[];
  readonly ambiguous: boolean;
  readonly alternatives: ReadonlyArray<{ readonly adapter: string; readonly confidence: number }>;
}

export interface Inspection {
  readonly framework: string;
  readonly version?: string;
  readonly entryFiles: readonly string[];
  readonly notes: readonly string[];
}

export interface HealthResult {
  readonly healthy: boolean;
  readonly detail?: string;
}

export interface ProjectAdapter {
  readonly id: string;
  readonly displayName: string;

  detect(root: string): Detection;
  inspect(root: string): Inspection;

  getDevCommand(root: string): CommandSpec | null;
  getDevUrl(root: string): UrlSpec | null;
  getBuildCommand(root: string): CommandSpec | null;
  getTestCommand(root: string): CommandSpec | null;

  getRelevantFiles(root: string, intent?: FeedbackIntent): string[];

  routes?: { readonly default: string; readonly presets?: readonly RoutePreset[] };
  capabilities?: AdapterCapabilities;
  healthCheck?(url: string): Promise<HealthResult>;
}
