import fs from "node:fs";

import { z } from "zod";

import { SKILL_NAMES } from "./agents/skill-registry.js";

const skillNameSchema = z.enum(SKILL_NAMES);

export const codingGatewayConfigSchema = z.object({
  model: z.string().min(1).default("gpt-5.4-mini"),
  reviewModel: z.string().min(1).default("gpt-5.4-mini"),
  plannerSkills: z
    .array(skillNameSchema)
    .default(["writing-plans", "brainstorming"]),
  planReviewerSkills: z
    .array(skillNameSchema)
    .default(["generic-plan-review"]),
  coderSkills: z
    .array(skillNameSchema)
    .default(["test-driven-development", "verification-before-completion"]),
  codeReviewerSkills: z
    .array(skillNameSchema)
    .default(["generic-code-review"]),
  maxPlanReviewLoops: z.number().int().positive().default(2),
  maxCodeReviewLoops: z.number().int().positive().default(3),
  maxSanityRetries: z.number().int().positive().default(3),
  verificationTimeoutMs: z.number().positive().default(300_000),
  testCommand: z.string().min(1).default("npm test"),
  lintCommand: z.string().min(1).default("npm run lint"),
  branchPrefix: z.string().min(1).default("agent/"),
  commitCoAuthor: z
    .string()
    .min(1)
    .default("agent-vm-coding <noreply@agent-vm>"),
  idleTimeoutMs: z.number().positive().default(1_800_000),
  stateDir: z.string().min(1).default("/state"),
});

export type CodingGatewayConfig = z.infer<typeof codingGatewayConfigSchema>;

export function loadConfig(configPath?: string): CodingGatewayConfig {
  if (configPath && fs.existsSync(configPath)) {
    const raw: unknown = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return codingGatewayConfigSchema.parse(raw);
  }

  return codingGatewayConfigSchema.parse({});
}
