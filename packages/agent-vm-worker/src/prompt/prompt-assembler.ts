import { existsSync, readFileSync } from 'node:fs';

import type { SkillReference } from '../shared/skill-types.js';
import type { StructuredInput } from '../work-executor/executor-interface.js';

const BASE_WORKER_PROMPT =
	'You are an agent working in a sandboxed VM. You have access to the workspace at /workspace. ' +
	'Do not attempt to access the network directly - all outbound requests go through a mediation proxy.';

const BASE_REVIEW_PROMPT =
	'Return your review as structured JSON matching the ReviewResult schema: ' +
	'{ approved: boolean, comments: [{ file: string, line?: number, severity: "critical" | "suggestion" | "nitpick", comment: string }], summary: string }';

const DEFAULT_PHASE_INSTRUCTIONS: Record<string, string> = {
	plan: 'Create an implementation plan for the task. Do not write code yet.',
	'plan-review': 'Review the plan for completeness, correctness, risks, and missing edge cases.',
	work: 'Implement the approved plan.',
	'work-review': 'Review the code changes for correctness, bugs, style, and test coverage.',
	wrapup:
		'Complete the task by running the configured wrapup actions. You have access to: ' +
		'git (commit, push, PR), Slack (webhook post). Decide which actions to take based on the task results.',
};

const REVIEW_PHASES = new Set(['plan-review', 'work-review']);

export function resolveSkillInputs(skills: readonly SkillReference[]): readonly StructuredInput[] {
	const result: StructuredInput[] = [];

	for (const skill of skills) {
		if (!existsSync(skill.path)) {
			continue;
		}

		result.push({
			type: 'skill',
			name: skill.name,
			content: readFileSync(skill.path, 'utf-8'),
		});
	}

	return result;
}

export interface AssemblePromptInput {
	readonly phase: string;
	readonly phaseInstructions?: string | undefined;
	readonly taskPrompt: string;
	readonly repo?: {
		readonly repoUrl: string;
		readonly baseBranch: string;
		readonly workspacePath: string;
	} | null;
	readonly context?: Record<string, unknown>;
	readonly repoSummary?: string | null;
	readonly plan?: string | null;
	readonly failureContext?: string | null;
	readonly skills: readonly SkillReference[];
}

export function assemblePrompt(input: AssemblePromptInput): readonly StructuredInput[] {
	const sections: string[] = [];

	sections.push(BASE_WORKER_PROMPT);
	if (REVIEW_PHASES.has(input.phase)) {
		sections.push('', BASE_REVIEW_PROMPT);
	}

	const instructions = input.phaseInstructions ?? DEFAULT_PHASE_INSTRUCTIONS[input.phase] ?? '';
	if (instructions.length > 0) {
		sections.push('', instructions);
	}

	sections.push('', `Task: ${input.taskPrompt}`);

	if (input.repo) {
		sections.push(
			'',
			`Repository: ${input.repo.repoUrl} (branch: ${input.repo.baseBranch})`,
			`Workspace: ${input.repo.workspacePath}`,
		);
	}

	if (input.context && Object.keys(input.context).length > 0) {
		sections.push('', 'Context:', JSON.stringify(input.context, null, 2));
	}

	if (input.repoSummary) {
		sections.push('', 'Repository summary:', input.repoSummary);
	}

	if (input.plan) {
		sections.push('', 'Approved plan:', input.plan);
	}

	if (input.failureContext) {
		sections.push('', 'Failure context from previous attempt:', input.failureContext);
	}

	return [{ type: 'text', text: sections.join('\n') }, ...resolveSkillInputs(input.skills)];
}
