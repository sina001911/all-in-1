/**
 * Package entrypoint — the OpenCode plugin (P6).
 *
 * Loads `src/plugin/index.ts`, which binds the verified `@opencode/plugin`
 * surface. The plugin is not auto-activated: loading it requires the user to
 * add it to `plugins` in their OpenCode configuration, which is a change to
 * THEIR configuration, never to this package's frozen defaults.
 *
 * Standalone use (no OpenCode) is unaffected and unchanged: `src/cli.ts` drives
 * the same engine from any directory with no configuration at all.
 */
export { default } from "./plugin/index.ts";
