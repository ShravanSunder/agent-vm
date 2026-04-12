import type { RepoContext } from "../context/gather-context.js";
import type { RetryPromptContext } from "../state/task-event-types.js";
import type { StructuredInput } from "../agents/shared-types.js";
import {
  resolveSkillInputs,
  type SkillName,
} from "../agents/skill-registry.js";

function withSkills(
  text: string,
  skills: readonly SkillName[],
): readonly StructuredInput[] {
  return [{ type: "text", text }, ...resolveSkillInputs(skills)];
}

export interface PlannerPromptInput {
  readonly taskPrompt: string;
  readonly context: RepoContext;
  readonly skills: readonly SkillName[];
}

export interface PlanRevisionPromptInput {
  readonly reviewSummary: string;
  readonly skills: readonly SkillName[];
}

export interface CoderImplementPromptInput {
  readonly plan: string;
  readonly skills: readonly SkillName[];
}

export interface CoderFixPromptInput {
  readonly reviewSummary: string;
  readonly skills: readonly SkillName[];
}

export interface CodeReviewPromptInput {
  readonly taskPrompt: string;
  readonly diff: string;
  readonly skills: readonly SkillName[];
}

export function buildPlannerPrompt(
  input: PlannerPromptInput,
): readonly StructuredInput[] {
  return withSkills(
    [
      `Task: ${input.taskPrompt}`,
      "",
      "Repository context:",
      input.context.summary,
      "",
      "Create an implementation plan. Do not write code yet.",
    ].join("\n"),
    input.skills,
  );
}

export function buildPlanRevisionPrompt(
  input: PlanRevisionPromptInput,
): readonly StructuredInput[] {
  return withSkills(
    `Revise the plan using this feedback:\n\n${input.reviewSummary}`,
    input.skills,
  );
}

export function buildCoderImplementPrompt(
  input: CoderImplementPromptInput,
): readonly StructuredInput[] {
  return withSkills(
    `Implement the approved plan:\n\n${input.plan}`,
    input.skills,
  );
}

export function buildCoderFixPrompt(
  input: CoderFixPromptInput,
): readonly StructuredInput[] {
  return withSkills(
    `Address the following feedback:\n\n${input.reviewSummary}`,
    input.skills,
  );
}

export function buildCoderRetryPrompt(
  retryContext: RetryPromptContext,
  skills: readonly SkillName[],
): readonly StructuredInput[] {
  return withSkills(
    [
      `Sanity verification failed on attempt ${retryContext.sanityCheckAttempt}/${retryContext.maxSanityRetries}.`,
      "",
      `Original task: ${retryContext.originalPrompt}`,
      "",
      `Files changed:\n${retryContext.filesChanged}`,
      "",
      `Test exit code: ${retryContext.testExitCode}`,
      retryContext.testOutput,
      "",
      `Lint exit code: ${retryContext.lintExitCode}`,
      retryContext.lintOutput,
    ].join("\n"),
    skills,
  );
}

export function buildPlanReviewPrompt(
  taskPrompt: string,
  plan: string,
  context: RepoContext,
  skills: readonly SkillName[],
): readonly StructuredInput[] {
  return withSkills(
    [
      `Original task: ${taskPrompt}`,
      "",
      "Repository context:",
      context.summary,
      "",
      "Plan to review:",
      plan,
      "",
      "Review the plan and return structured JSON.",
    ].join("\n"),
    skills,
  );
}

export function buildCodeReviewPrompt(
  input: CodeReviewPromptInput,
): readonly StructuredInput[] {
  return withSkills(
    [
      `Original task: ${input.taskPrompt}`,
      "",
      "Diff to review:",
      input.diff,
      "",
      "Review the code changes and return structured JSON.",
    ].join("\n"),
    input.skills,
  );
}
