import { describe, expect, it } from "vitest";

import {
  AVAILABLE_SKILLS,
  SKILL_NAMES,
  resolveSkillInputs,
} from "./skill-registry.js";

describe("skill-registry", () => {
  it("should have all expected skills", () => {
    expect(SKILL_NAMES).toContain("writing-plans");
    expect(SKILL_NAMES).toContain("test-driven-development");
    expect(SKILL_NAMES).toContain("generic-plan-review");
    expect(SKILL_NAMES).toContain("generic-code-review");
    expect(SKILL_NAMES).toHaveLength(10);
  });

  it("should resolve skill names to structured inputs", () => {
    const inputs = resolveSkillInputs(["writing-plans", "brainstorming"]);

    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toEqual({
      type: "skill",
      name: "writing-plans",
      path: "~/.agents/skills/writing-plans/SKILL.md",
    });
  });

  it("should have correct source for each skill", () => {
    expect(AVAILABLE_SKILLS["writing-plans"].source).toBe("superpowers");
    expect(AVAILABLE_SKILLS["code-reviewer"].source).toBe("relay-ai");
    expect(AVAILABLE_SKILLS["generic-plan-review"].source).toBe("builtin");
  });
});
