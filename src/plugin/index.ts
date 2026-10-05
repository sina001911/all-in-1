/**
 * OpenCode plugin binding (P6).
 *
 * This is the ONLY module that imports the OpenCode plugin SDK. The import is
 * real: at runtime the OpenCode host supplies `@opencode/plugin` from its own
 * module graph. It is resolved through the ambient contract in
 * `src/opencode-plugin.d.ts` at type-check time, so the package type-checks
 * deterministically with zero npm dependencies and no `node_modules` present.
 *
 * The plugin registers commands and nothing else. It registers no provider, no
 * model, no tool, and no integration: the frozen defaults (FREE_ONLY, zero
 * budget, deny-all egress, MAIN_CODER immutability, media disabled) are
 * untouched, and the package stays inert until a human loads it and opens a
 * remote path through the three explicit acts outside this file.
 *
 * The only file writers remain the OpenCode tools. This binding exposes
 * analysis and planning commands; it never writes.
 */
import { Plugin } from "@opencode/plugin";
import { registerAllInOneCommands } from "./commands.ts";

const plugin = Plugin.define({
  id: "all-in-1",
  async setup(ctx) {
    // Commands route every request through the P4 engine and its gates.
    const registration = await registerAllInOneCommands(ctx);
    // Dispose the command registration when the plugin unloads.
    return () => {
      void registration.dispose();
    };
  },
});

export default plugin;
