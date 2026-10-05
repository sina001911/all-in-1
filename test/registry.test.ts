/**
 * Registry suite: roles are the only participation path; every role has a
 * fallback; MAIN_CODER is immutable and invisible to candidate selection.
 */
import { describe, expect, it } from "vitest";
import { ModelRegistry } from "../src/registry/model.registry.ts";
import { registerStubs, stubFor } from "../src/registry/stub.ts";
import { MODEL_ROLES, ROLE_DEFINITIONS } from "../src/registry/roles.ts";

describe("role registry", () => {
  it("defines every role with no edit and no decide rights", () => {
    for (const role of MODEL_ROLES) {
      const def = ROLE_DEFINITIONS[role];
      expect(def).toBeDefined();
      expect(def.mayEditProject).toBe(false);
      expect(def.mayDecide).toBe(false);
    }
  });

  it("gives every non-router role a fallback or declares it terminal", () => {
    for (const role of MODEL_ROLES) {
      if (role === "MAIN_CODER" || role === "MODEL_ROUTER") continue;
      const def = ROLE_DEFINITIONS[role];
      // fallback may be null only for FAST_TASK (terminal) and media roles (disabled)
      if (def.fallback === null) {
        expect(["FAST_TASK", "IMAGE_GENERATOR", "IMAGE_EDITOR", "VIDEO_GENERATOR", "VIDEO_EDITOR"]).toContain(role);
      }
    }
  });
});

describe("stub registration", () => {
  it("registers a deterministic stub for every role except MAIN_CODER", () => {
    const registry = new ModelRegistry();
    registerStubs(registry);
    for (const role of MODEL_ROLES) {
      if (role === "MAIN_CODER") {
        expect(registry.get(stubFor(role))).toBeUndefined();
      } else {
        expect(registry.get(stubFor(role))).toBeDefined();
      }
    }
  });

  it("never registers MAIN_CODER as a candidate", () => {
    const registry = new ModelRegistry();
    registerStubs(registry);
    expect(registry.candidatesFor("MAIN_CODER")).toHaveLength(0);
  });
});
