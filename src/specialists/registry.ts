/**
 * Specialist registry (P5).
 *
 * A specialist is a named, role-tagged entry point that produces structured
 * analysis — JSON in, JSON out, and *never* a tool. This registry owns the
 * discovery surface: what specialists exist, which role they run under, and the
 * output contract they claim to satisfy. It holds no call state and performs no
 * invocation; that is the runner's job.
 *
 * Relationship to the frozen layers: a specialist does not bypass routing. Its
 * role is mapped onto a capability through the P3 bridge and executed through
 * the P4 engine, so every policy, approval, egress, secret, and budget gate
 * still applies unchanged.
 */
import type { ModelRole } from "../registry/roles.ts";
import type { Schema } from "./validator.ts";

export interface SpecialistDescriptor {
  /** Stable identifier, used by the CLI and logs. */
  readonly id: string;
  /** The role this specialist runs under; routed via the P3 bridge. */
  readonly role: ModelRole;
  readonly description: string;
  /** Output contract the specialist claims when none is given per-call. */
  readonly defaultOutputSchema?: Schema;
}

export class SpecialistRegistry {
  private readonly byId = new Map<string, SpecialistDescriptor>();
  private readonly byRole = new Map<string, SpecialistDescriptor[]>();

  register(descriptor: SpecialistDescriptor): void {
    if (this.byId.has(descriptor.id)) {
      throw new Error(`Specialist already registered: ${descriptor.id}`);
    }
    this.byId.set(descriptor.id, descriptor);
    const list = this.byRole.get(descriptor.role) ?? [];
    list.push(descriptor);
    this.byRole.set(descriptor.role, list);
  }

  get(id: string): SpecialistDescriptor | undefined {
    return this.byId.get(id);
  }

  bySpecialistRole(role: ModelRole): readonly SpecialistDescriptor[] {
    return this.byRole.get(role) ?? [];
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  list(): readonly SpecialistDescriptor[] {
    return [...this.byId.values()];
  }
}

/**
 * Register the baseline specialists: one per role the deterministic local
 * models can serve. These are the only specialists wired in by default, so the
 * layer is exercisable offline and without credentials. A specialist that calls
 * a real provider stays unregistered until a user explicitly adds it.
 */
export function registerBaselineSpecialists(registry: SpecialistRegistry): void {
  registry.register({
    id: "code-review",
    role: "CODE_REVIEWER",
    description: "Structured review of a change or file: findings by severity, with rationale.",
  });
  registry.register({
    id: "deep-reasoning",
    role: "DEEP_REASONING",
    description: "Step-by-step structured reasoning over a problem statement.",
  });
  registry.register({
    id: "coding-assistant",
    role: "CODING_ASSISTANT",
    description: "Structured answer to a coding question with citations to the input.",
  });
  registry.register({
    id: "fast-task",
    role: "FAST_TASK",
    description: "Short, deterministic structured answer for low-latency tasks.",
  });
  registry.register({
    id: "screenshot-analysis",
    role: "VISION",
    description: "Structured description of a captured screenshot, honouring locale.",
  });
  registry.register({
    id: "visual-qa",
    role: "VISUAL_QA",
    description: "Structured yes/no plus evidence answer about a captured image.",
  });
}
