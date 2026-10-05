/**
 * Vitest configuration.
 *
 * D1 adds a desktop package with its own tests. Running them from the repo
 * root keeps a single `npm test` command as the source of truth for the whole
 * project, so the existing 375 core tests and the new desktop tests are always
 * verified together.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "desktop/test/**/*.test.ts"],
    exclude: ["test/fixtures/**", "node_modules/**", "desktop/node_modules/**"],
  },
});
