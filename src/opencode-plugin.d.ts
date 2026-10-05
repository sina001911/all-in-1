/**
 * Ambient contract for the OpenCode plugin SDK (P6).
 *
 * This declares ONLY the surface that `src/plugin/index.ts` consumes, modelled
 * on the verified public exports of `@opencode/plugin@2.0.22` — the V2 Promise
 * API under `dist/promise/*`:
 *
 *   - `Plugin.define` / `Plugin.Plugin` / `Plugin.Context` / `Plugin.Cleanup`
 *   - `ctx.command.transform` + `CommandEditor.add` + `CommandDefinition`
 *   - `ctx.session.prompt`
 *
 * WHY AN AMBIENT DECLARATION AND NOT A DEPENDENCY
 *
 * Two properties of the package were verified and both are blockers for a real
 * dependency, so the frozen isolation requirement (one self-contained package,
 * zero npm dependencies) is not relaxed to make integration convenient:
 *
 *   1. It is not resolvable from this project's directory. `require.resolve`
 *      returns MODULE_NOT_FOUND for `@opencode/plugin`, `@opencode-ai/plugin`,
 *      and their subpaths; the module is only resolvable from the OpenCode
 *      host's own node_modules. Depending on it would mean relying on
 *      parent-directory hoisting.
 *   2. Type-checking against it pulls in a transitive declaration gap:
 *      `@ai-sdk/provider/dist/index.d.ts` imports `json-schema`, which ships
 *      no types, so `tsc --noEmit --strict` emits TS7016. Closing that requires
 *      patching a transitive package.
 *
 * The OpenCode host supplies the real module at runtime — that is the normal
 * plugin mechanism — so the runtime import is genuine. This declaration is what
 * lets the package type-check deterministically with NO `node_modules` present.
 * `dependencies` in package.json stays empty.
 *
 * DRIFT CONTROL
 *
 * Deep schema types are narrowed to the fields this plugin actually reads
 * (`PromptInput` to `text`/`files`, `SessionInbox.Delivery` to its literal
 * union, `FileAttachment` to `uri`/`name`/`description`). The real types are
 * supersets of these, so a real runtime value remains assignable to every
 * declaration here. `test/p6-plugin.test.ts` pins the surface this file
 * declares against a snapshot, and `docs/p6.md` records the verified version and
 * the exact re-verification procedure.
 */
declare module "@opencode/plugin" {
  export namespace Plugin {
    export interface Plugin {
      readonly id: string;
      readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void;
    }

    export type Cleanup = () => Promise<void> | void;

    export interface Context {
      readonly command: CommandDomain;
      readonly session: SessionDomain;
    }

    export function define(plugin: Plugin): Plugin;
  }

  export interface Registration {
    readonly dispose: () => Promise<void>;
  }

  export interface CommandDefinition {
    readonly name: string;
    readonly description?: string;
    readonly execute: (input: CommandInvocation) => Promise<void>;
  }

  export interface CommandEditor {
    add(definition: CommandDefinition): void;
  }

  export interface CommandDomain {
    readonly transform: (callback: (editor: CommandEditor) => void) => Promise<Registration>;
    readonly reload: () => Promise<void>;
  }

  export interface CommandInvocation {
    readonly sessionID: string;
    readonly prompt: PromptInput;
    readonly delivery: SessionDelivery;
  }

  export interface SessionDomain {
    readonly prompt: (input: SessionPromptInput) => Promise<unknown>;
  }

  export interface SessionPromptInput {
    readonly sessionID: string;
    readonly text: string;
    readonly files?: readonly FileAttachment[];
    readonly delivery?: SessionDelivery;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }

  export interface PromptInput {
    readonly text: string;
    readonly files?: readonly FileAttachment[];
  }

  export interface FileAttachment {
    readonly uri: string;
    readonly name?: string;
    readonly description?: string;
  }

  export type SessionDelivery = "steer" | "queue";
}
