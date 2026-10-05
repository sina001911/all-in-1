/**
 * Role registry. Roles are the ONLY way models participate in the system.
 *
 * Atria-Dawn-Preview / s1 is MAIN_CODER and is router-immutable: the router has
 * no code path that can return or override it. `resolve("MAIN_CODER")` throws.
 */
import type { CostPolicy } from "./cost-policy.ts";

export const MODEL_ROLES = [
  // --- MVP roles ---
  "MAIN_CODER",
  "CODING_ASSISTANT",
  "DEEP_REASONING",
  "CODE_REVIEWER",
  "VISION",
  "VISUAL_QA",
  "FAST_TASK",
  // --- Media roles (scaffold; media.enabled = false in MVP) ---
  "IMAGE_GENERATOR",
  "IMAGE_EDITOR",
  "VIDEO_GENERATOR",
  "VIDEO_EDITOR",
  "VIDEO_UNDERSTANDING",
  "MEDIA_QA",
  // --- Router ---
  "MODEL_ROUTER",
] as const;

export type ModelRole = (typeof MODEL_ROLES)[number];

export interface RoleDefinition {
  readonly id: ModelRole;
  readonly description: string;
  readonly defaultPolicy: CostPolicy;
  /** No specialist can edit project files or decide. Only Atria can. */
  readonly mayEditProject: false;
  readonly mayDecide: false;
  readonly autoInvocable: boolean;
  readonly fallback: ModelRole | null;
}

export const ROLE_DEFINITIONS: Readonly<Record<ModelRole, RoleDefinition>> = {
  MAIN_CODER: {
    id: "MAIN_CODER",
    description:
      "Atria-Dawn-Preview. Main coding/reasoning brain and final decision-maker. Immutable.",
    defaultPolicy: "PREMIUM_ALLOWED", // never consulted through the router; fixed binding instead
    mayEditProject: false, // edits flow through OpenCode tools under Atria's control
    mayDecide: false,
    autoInvocable: false,
    fallback: null,
  },
  CODING_ASSISTANT: {
    id: "CODING_ASSISTANT",
    description: "Drafts edits that Atria reviews, approves, and applies.",
    defaultPolicy: "FREE_ONLY",
    mayEditProject: false,
    mayDecide: false,
    autoInvocable: false,
    fallback: "FAST_TASK",
  },
  DEEP_REASONING: {
    id: "DEEP_REASONING",
    description: "Architecture and hard-debugging analysis, on Atria's request.",
    defaultPolicy: "PREFERRED_FREE",
    mayEditProject: false,
    mayDecide: false,
    autoInvocable: false,
    fallback: "FAST_TASK",
  },
  CODE_REVIEWER: {
    id: "CODE_REVIEWER",
    description: "Advisory review of Atria's proposed diff. Never applies anything.",
    defaultPolicy: "PREFERRED_FREE",
    mayEditProject: false,
    mayDecide: false,
    autoInvocable: false,
    fallback: "FAST_TASK",
  },
  VISION: {
    id: "VISION",
    description: "Screenshot -> structured UI/UX analysis. Untrusted perception layer.",
    defaultPolicy: "FREE_ONLY",
    mayEditProject: false,
    mayDecide: false,
    autoInvocable: true,
    fallback: "FAST_TASK",
  },
  VISUAL_QA: {
    id: "VISUAL_QA",
    description: "Target-vs-current comparison and defect detection.",
    defaultPolicy: "FREE_ONLY",
    mayEditProject: false,
    mayDecide: false,
    autoInvocable: true,
    fallback: "VISION",
  },
  FAST_TASK: {
    id: "FAST_TASK",
    description: "Summaries, labels, triage, small structured JSON.",
    defaultPolicy: "FREE_ONLY",
    mayEditProject: false,
    mayDecide: false,
    autoInvocable: true,
    fallback: null,
  },
  IMAGE_GENERATOR: {
    id: "IMAGE_GENERATOR",
    description: "text->image / image->image. Scaffold only; disabled in MVP.",
    defaultPolicy: "FREE_ONLY",
    mayEditProject: false,
    mayDecide: false,
    autoInvocable: false,
    fallback: null,
  },
  IMAGE_EDITOR: {
    id: "IMAGE_EDITOR",
    description: "image edit / inpaint / upscale. Scaffold only; disabled in MVP.",
    defaultPolicy: "FREE_ONLY",
    mayEditProject: false,
    mayDecide: false,
    autoInvocable: false,
    fallback: null,
  },
  VIDEO_GENERATOR: {
    id: "VIDEO_GENERATOR",
    description: "text->video / image->video. Scaffold only; disabled in MVP.",
    defaultPolicy: "FREE_ONLY",
    mayEditProject: false,
    mayDecide: false,
    autoInvocable: false,
    fallback: null,
  },
  VIDEO_EDITOR: {
    id: "VIDEO_EDITOR",
    description: "video editing. Scaffold only; disabled in MVP.",
    defaultPolicy: "FREE_ONLY",
    mayEditProject: false,
    mayDecide: false,
    autoInvocable: false,
    fallback: null,
  },
  VIDEO_UNDERSTANDING: {
    id: "VIDEO_UNDERSTANDING",
    description: "video -> structured analysis. Scaffold only; disabled in MVP.",
    defaultPolicy: "FREE_ONLY",
    mayEditProject: false,
    mayDecide: false,
    autoInvocable: false,
    fallback: "VISION",
  },
  MEDIA_QA: {
    id: "MEDIA_QA",
    description: "Media asset validation. Scaffold only; disabled in MVP.",
    defaultPolicy: "FREE_ONLY",
    mayEditProject: false,
    mayDecide: false,
    autoInvocable: false,
    fallback: "FAST_TASK",
  },
  MODEL_ROUTER: {
    id: "MODEL_ROUTER",
    description: "Deterministic role->model resolution. Not an LLM in the MVP.",
    defaultPolicy: "FREE_ONLY",
    mayEditProject: false,
    mayDecide: false,
    autoInvocable: true,
    fallback: null,
  },
};

export function getRoleDefinition(id: ModelRole): RoleDefinition {
  const def = ROLE_DEFINITIONS[id];
  if (!def) throw new Error(`Unknown role: ${id as string}`);
  return def;
}

export class RoleNotRoutableError extends Error {
  readonly role: ModelRole;
  constructor(role: ModelRole) {
    super(`Role not routable: ${role}. MAIN_CODER is immutable and cannot be resolved by the router.`);
    this.name = "RoleNotRoutableError";
    this.role = role;
  }
}
