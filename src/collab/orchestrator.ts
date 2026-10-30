/**
 * Collaborate orchestrator (D34) — configurable multi-model execution.
 *
 * The orchestrator turns a `CollaborateRequest` into a set of independent,
 * fully-gated specialist runs and reconciles their outputs. It is deliberately
 * thin: it owns no engine, no credentials, no file access. Every participant
 * is a `SpecialistRequest` dispatched through the caller-supplied
 * `SpecialistRunner`, so the seven gates — SELECT, VALIDATE, EGRESS, APPROVAL,
 * RESERVE, INVOKE, SETTLE — apply unchanged to each one.
 *
 * Three strategies:
 *   - `parallel`   — every participant runs concurrently through a bounded
 *                    pool. A failure is isolated to its own participant.
 *   - `sequential` — each participant sees the previous one's answer as
 *                    context. A non-retryable failure stops the chain.
 *   - `debate`     — parallel execution, then structured outputs are compared
 *                    pairwise and disagreements are surfaced for synthesis.
 *
 * Cancellation is honoured between participants and forwarded to the engine,
 * so a cancelled run never holds a budget reservation.
 */
import type { InvokeOptions } from "../execution/engine.ts";
import type { StreamEvent } from "../execution/types.ts";
import type { SpecialistRequest, SpecialistResponse } from "../specialists/types.ts";
import type { SpecialistRunner } from "../specialists/runner.ts";
import { AllInOneError } from "../errors.ts";
import type {
  CollaborateParticipant,
  CollaborateParticipantResult,
  CollaborateRequest,
  CollaborateResult,
  CollaborateSynthesis,
  Disagreement,
} from "./types.ts";

/** A stream frame tagged with the participant it belongs to. */
export type CollabStreamEvent = StreamEvent & { readonly participantId: string };

export interface CollaborateOrchestratorOptions {
  /** The fully-gated specialist runner the participants execute through. */
  readonly runner: SpecialistRunner;
  readonly request: CollaborateRequest;
  /** Progressive participant frames; the caller tags them with a stream key. */
  readonly onStreamEvent?: (event: CollabStreamEvent) => void;
}

const DEFAULT_CONCURRENCY = 4;

export class CollaborateOrchestrator {
  private readonly opts: CollaborateOrchestratorOptions;

  constructor(opts: CollaborateOrchestratorOptions) {
    this.opts = opts;
  }

  async run(): Promise<CollaborateResult> {
    const { request } = this.opts;

    // Validation is structural and cheap: no side effects, no engine.
    const invalid = this.validate(request);
    if (invalid) return invalid;

    let participants: readonly CollaborateParticipantResult[];
    switch (request.strategy) {
      case "parallel":
        participants = await this.runPool(request.participants, request.task);
        break;
      case "sequential":
        participants = await this.runSequential(request.participants, request.task);
        break;
      case "debate":
        participants = await this.runPool(request.participants, request.task);
        break;
    }

    const disagreements =
      request.strategy === "debate"
        ? this.reconcile(participants)
        : undefined;

    let synthesis: CollaborateSynthesis | undefined;
    if (request.synthesis) {
      synthesis = await this.synthesize(request, participants, disagreements);
    }

    // `ok` when at least one participant settled or a synthesis was produced.
    const ok = participants.some((p) => p.ok) || synthesis !== undefined;
    const result: CollaborateResult = ok
      ? {
          ok,
          runId: request.runId ?? "collab",
          strategy: request.strategy,
          participants,
          synthesis,
          disagreements,
        }
      : {
          ok: false,
          runId: request.runId ?? "collab",
          strategy: request.strategy,
          participants,
          synthesis,
          disagreements,
          error: {
            code: "COLLAB_ALL_FAILED",
            message: "every participant failed or produced no answer",
            retryable: false,
          },
        };
    return result;
  }

  private validate(request: CollaborateRequest): CollaborateResult | undefined {
    const runId = request.runId ?? "collab";
    if (!request.task || request.task.trim() === "") {
      return this.failure(runId, request.strategy, "INVALID_COLLAB_REQUEST", "task must be a non-empty string");
    }
    if (request.strategy !== "parallel" && request.strategy !== "sequential" && request.strategy !== "debate") {
      return this.failure(runId, request.strategy, "INVALID_STRATEGY", `Invalid strategy: ${String(request.strategy)}`);
    }
    if (!Array.isArray(request.participants) || request.participants.length < 2) {
      return this.failure(runId, request.strategy, "NO_PARTICIPANTS", "collaborate requires at least two participants");
    }
    for (const p of request.participants) {
      if (typeof p.id !== "string" || p.id.trim() === "") {
        return this.failure(runId, request.strategy, "INVALID_PARTICIPANT", "participant id must be a non-empty string");
      }
      if (typeof p.provider !== "string" || p.provider.trim() === "") {
        return this.failure(runId, request.strategy, "INVALID_PARTICIPANT", "participant provider must be a non-empty string");
      }
      if (typeof p.modelId !== "string" || p.modelId.trim() === "") {
        return this.failure(runId, request.strategy, "INVALID_PARTICIPANT", "participant modelId must be a non-empty string");
      }
      if (typeof p.task !== "string" || p.task.trim() === "") {
        return this.failure(runId, request.strategy, "INVALID_PARTICIPANT", "participant task must be a non-empty string");
      }
    }
    // Role routing (including MAIN_CODER's immutability) is settled where the
    // registry lives: the runner rejects an unregistered role — or MAIN_CODER,
    // which is a fixed binding, not a specialist — as `SPECIALIST_NOT_FOUND`
    // for that participant. Structural checks stay to the fields this class
    // can see; role reachability is never decided here.
    return undefined;
  }

  /** Bounded pool: at most `DEFAULT_CONCURRENCY` participants run at once. */
  private async runPool(
    participants: readonly CollaborateParticipant[],
    task: string,
  ): Promise<readonly CollaborateParticipantResult[]> {
    const results: CollaborateParticipantResult[] = new Array(participants.length);
    const concurrency = Math.max(1, Math.min(DEFAULT_CONCURRENCY, participants.length));
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < participants.length) {
        const i = cursor;
        cursor += 1;
        if (this.opts.request.signal?.aborted) {
          results[i] = this.cancelledParticipant(participants[i]);
          continue;
        }
        results[i] = await this.runParticipant(participants[i], task);
      }
    };
    const workers: Promise<void>[] = [];
    for (let w = 0; w < concurrency; w++) workers.push(worker());
    await Promise.all(workers);
    return results;
  }

  private async runSequential(
    participants: readonly CollaborateParticipant[],
    task: string,
  ): Promise<readonly CollaborateParticipantResult[]> {
    const results: CollaborateParticipantResult[] = [];
    let context = task;
    for (let i = 0; i < participants.length; i++) {
      const p = participants[i];
      if (this.opts.request.signal?.aborted) {
        results.push(this.cancelledParticipant(p));
        continue;
      }
      const r = await this.runParticipant(p, context);
      results.push(r);
      // A successful answer becomes the next participant's context. A failed
      // one is not forwarded: the chain has no reliable basis to continue.
      if (r.ok && r.text) context = r.text;
      // A non-retryable failure stops the chain; the remaining participants
      // are recorded as skipped so the array stays aligned with the request.
      if (!r.ok && !r.error?.retryable) {
        for (let j = i + 1; j < participants.length; j++) {
          results.push(this.skippedParticipant(participants[j]));
        }
        return results;
      }
    }
    return results;
  }

  private async runParticipant(
    p: CollaborateParticipant,
    context: string,
  ): Promise<CollaborateParticipantResult> {
    const composite = `${p.provider}/${p.modelId}`;
    const req: SpecialistRequest = {
      role: p.role,
      prompt: context ? `${context}\n\nYour specific assignment: ${p.task}` : p.task,
      inputs: [{ kind: "text", text: context || p.task }],
      outputSchema: {},
      streaming: this.opts.request.streaming === true && p.streaming !== false,
    };
    const invokeOptions: InvokeOptions = {
      timeoutMs: this.opts.request.timeoutMs,
      signal: this.opts.request.signal,
      onStreamEvent: this.opts.onStreamEvent
        ? (e: StreamEvent) => this.opts.onStreamEvent!({ ...e, participantId: p.id })
        : undefined,
    };

    let response: SpecialistResponse;
    try {
      response = await this.opts.runner.run(req, invokeOptions);
    } catch (e) {
      const err = e as AllInOneError;
      return {
        participant: p,
        ok: false,
        structured: null,
        text: "",
        modelId: composite,
        error: {
          code: err.code ?? "PROVIDER_CALL_FAILED",
          message: err.message,
          retryable: err.retryable ?? false,
        },
      };
    }

    if (response.ok) {
      const text = this.textFromStructured(response.structured, p);
      return {
        participant: p,
        ok: true,
        structured: response.structured,
        text,
        modelId: response.accounting?.modelId ?? composite,
        accounting: response.accounting,
      };
    }
    return {
      participant: p,
      ok: false,
      structured: null,
      text: "",
      modelId: response.accounting?.modelId ?? composite,
      accounting: response.accounting,
      error: response.error,
    };
  }

  /** Reconcile pairwise: a field two participants set to different values. */
  private reconcile(results: readonly CollaborateParticipantResult[]): Disagreement[] {
    const disagreements: Disagreement[] = [];
    const ok = results.filter((r) => r.ok && r.structured !== null && r.structured !== undefined);
    for (let i = 0; i < ok.length; i++) {
      for (let j = i + 1; j < ok.length; j++) {
        const a = ok[i].structured as Record<string, unknown> | null;
        const b = ok[j].structured as Record<string, unknown> | null;
        if (!a || !b || typeof a !== "object" || typeof b !== "object") continue;
        for (const key of Object.keys(a)) {
          if (!(key in b)) continue;
          const av = JSON.stringify(a[key] ?? null);
          const bv = JSON.stringify(b[key] ?? null);
          if (av !== bv) {
            disagreements.push({
              between: [ok[i].participant.id, ok[j].participant.id],
              field: key,
              a: av,
              b: bv,
              resolution: "unresolved",
            });
          }
        }
      }
    }
    return disagreements;
  }

  /** Combine outputs under the named synthesis model. Never a hidden default. */
  private async synthesize(
    request: CollaborateRequest,
    results: readonly CollaborateParticipantResult[],
    disagreements: readonly Disagreement[] | undefined,
  ): Promise<CollaborateSynthesis | undefined> {
    if (!request.synthesis) return undefined;
    const prompt = this.buildSynthesisPrompt(request, results, disagreements);
    const req: SpecialistRequest = {
      role: "DEEP_REASONING",
      prompt,
      inputs: [{ kind: "text", text: prompt }],
      outputSchema: {},
      streaming: request.streaming === true,
    };
    const invokeOptions: InvokeOptions = {
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      onStreamEvent: this.opts.onStreamEvent
        ? (e: StreamEvent) => this.opts.onStreamEvent!({ ...e, participantId: "synthesis" })
        : undefined,
    };
    try {
      const response = await this.opts.runner.run(req, invokeOptions);
      if (!response.ok) return undefined;
      const okParts = results.filter((r) => r.ok);
      const provenance = okParts.map((r) => ({
        participantId: r.participant.id,
        excerpt: r.text.slice(0, 200),
      }));
      return {
        text: this.textFromStructured(response.structured, {
          id: "synthesis",
          provider: request.synthesis!.provider,
          modelId: request.synthesis!.modelId,
          role: "DEEP_REASONING",
          task: "synthesize",
        } satisfies CollaborateParticipant),
        modelId: response.accounting?.modelId ?? `${request.synthesis!.provider}/${request.synthesis!.modelId}`,
        provenance,
      };
    } catch {
      // Synthesis is optional: a failed synthesis never turns a set of
      // successful participant answers into a hard failure.
      return undefined;
    }
  }

  private buildSynthesisPrompt(
    request: CollaborateRequest,
    results: readonly CollaborateParticipantResult[],
    disagreements: readonly Disagreement[] | undefined,
  ): string {
    const okParts = results.filter((r) => r.ok);
    const lines: string[] = [];
    lines.push(`You are synthesizing the outputs of ${okParts.length} specialist analyses for this task:`);
    lines.push(`"${request.task}"`);
    lines.push("");
    lines.push("Participant outputs:");
    for (const r of okParts) {
      lines.push(`- ${r.participant.id} (${r.participant.role}): ${r.text}`);
    }
    if (disagreements && disagreements.length > 0) {
      lines.push("");
      lines.push("Disagreements to resolve:");
      for (const d of disagreements) {
        lines.push(`- ${d.between[0]} vs ${d.between[1]} on "${d.field}": "${d.a}" vs "${d.b}"`);
      }
    }
    lines.push("");
    lines.push("Produce a single coherent answer. For each disagreement, pick a side or merge, and state which participant each part drew on.");
    return lines.join("\n");
  }

  private textFromStructured(structured: unknown, p: CollaborateParticipant): string {
    if (typeof structured === "string") return structured;
    if (structured && typeof structured === "object") {
      const rec = structured as Record<string, unknown>;
      for (const key of ["text", "summary", "answer", "verdict", "recommendation", "findings"]) {
        if (typeof rec[key] === "string") return rec[key] as string;
        if (rec[key] !== undefined && rec[key] !== null) {
          return JSON.stringify(rec[key]);
        }
      }
      return JSON.stringify(structured);
    }
    return structured == null ? p.task : String(structured);
  }

  private cancelledParticipant(p: CollaborateParticipant): CollaborateParticipantResult {
    return {
      participant: p,
      ok: false,
      structured: null,
      text: "",
      modelId: `${p.provider}/${p.modelId}`,
      error: { code: "COLLAB_CANCELLED", message: "collaborate cancelled by the caller", retryable: false },
    };
  }

  private skippedParticipant(p: CollaborateParticipant): CollaborateParticipantResult {
    return {
      participant: p,
      ok: false,
      structured: null,
      text: "",
      modelId: `${p.provider}/${p.modelId}`,
      error: { code: "COLLAB_SKIPPED", message: "skipped: a prior participant failed in a non-retryable way", retryable: false },
    };
  }

  private failure(
    runId: string,
    strategy: CollaborateRequest["strategy"],
    code: string,
    message: string,
  ): CollaborateResult {
    return {
      ok: false,
      runId,
      strategy,
      participants: [],
      error: { code, message, retryable: false },
    };
  }
}
