/**
 * A swap-point for the invocation portal (D10).
 *
 * The gateway, the workflow runner, and the facade all hold an
 * `InvocationPortal` from construction. Hot-replacing the provider stack
 * replaces the engine behind it; this tiny holder is the single reference
 * they keep, so the swap is visible to them without re-binding any
 * constructor-injected reference.
 *
 * It deliberately implements the SAME narrow interface (`InvocationPortal`):
 * no new gate, no new behaviour — invocation just delegates to whatever the
 * current engine is.
 */
import type { InvocationPortal, InvokeOptions, ExecutionOutcome } from "./engine.ts";
import type { SelectionRequest } from "../models/types.ts";

export class SwappablePortal implements InvocationPortal {
  private current: InvocationPortal;

  constructor(initial: InvocationPortal) {
    this.current = initial;
  }

  /** The engine currently serving NEW invocations. */
  get currentEngine(): InvocationPortal {
    return this.current;
  }

  swap(next: InvocationPortal): void {
    this.current = next;
  }

  invoke(request: SelectionRequest, options?: InvokeOptions): Promise<ExecutionOutcome> {
    // The delegate is resolved at call start: an invocation already running
    // under the previous engine finishes under it; a later call goes to the
    // new one. No in-flight call is torn down mid-flight.
    return this.current.invoke(request, options);
  }
}
