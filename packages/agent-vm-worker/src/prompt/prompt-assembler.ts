import { readFile } from 'node:fs/promises';

import { reviewPhaseNames } from '../shared/phase-names.js';
import type { RepoLocation } from '../shared/repo-location.js';
import type { SkillReference } from '../shared/skill-types.js';
import type { PhaseName } from '../state/task-event-types.js';
import type { StructuredInput } from '../work-executor/executor-interface.js';
import { DEFAULT_BASE_INSTRUCTIONS, getDefaultPhaseInstruction } from './prompt-defaults.js';

const BASE_WORKER_PROMPT =
	'You are an agent working in a sandboxed VM. You have access to the workspace at /workspace. ' +
	'Do not attempt to access the network directly - all outbound requests go through a mediation proxy.';

const BASE_REVIEW_PROMPT =
	'Return your review as structured JSON matching the ReviewResult schema: ' +
	'{ approved: boolean, comments: [{ file: string, line?: number, severity: "critical" | "suggestion" | "nitpick", comment: string }], summary: string }';

const REVIEW_PHASES = new Set<PhaseName>(reviewPhaseNames);

export async function resolveSkillInputs(
	skills: readonly SkillReference[],
): Promise<readonly StructuredInput[]> {
	const resolvedInputs = await Promise.all(
		skills.map(async (skill): Promise<StructuredInput | null> => {
			try {
				const content = await readFile(skill.path, 'utf-8');
				return {
					type: 'skill',
					name: skill.name,
					content,
				};
			} catch (error) {
				if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
					return null;
				}
				return null;
			}
		}),
	);

	return resolvedInputs.filter((input): input is StructuredInput => input !== null);
}

export interface AssemblePromptInput {
	readonly phase: PhaseName;
	readonly baseInstructions?: string | undefined;
	readonly phaseInstructions?: string | undefined;
	readonly taskPrompt: string;
	readonly repos?: readonly RepoLocation[];
	readonly context?: Record<string, unknown>;
	readonly repoSummary?: string | null;
	readonly plan?: string | null;
	readonly failureContext?: string | null;
	readonly extraContext?: string | null;
	readonly skills: readonly SkillReference[];
}

export async function assemblePrompt(
	input: AssemblePromptInput,
): Promise<readonly StructuredInput[]> {
	const sections: string[] = [];

	sections.push(BASE_WORKER_PROMPT);
	sections.push('', input.baseInstructions ?? DEFAULT_BASE_INSTRUCTIONS);
	if (REVIEW_PHASES.has(input.phase)) {
		sections.push('', BASE_REVIEW_PROMPT);
	}

	const instructions = input.phaseInstructions ?? getDefaultPhaseInstruction(input.phase) ?? '';
	if (instructions.length > 0) {
		sections.push('', instructions);
	}

	sections.push('', `Task: ${input.taskPrompt}`);

	if (input.repos && input.repos.length > 0) {
		sections.push('', 'Repositories:');
		for (const repo of input.repos) {
			sections.push(
				`- ${repo.repoUrl} (branch: ${repo.baseBranch})`,
				`  Workspace: ${repo.workspacePath}`,
			);
		}
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

	if (input.extraContext) {
		sections.push('', 'Additional context:', input.extraContext);
	}

	return [{ type: 'text', text: sections.join('\n') }, ...(await resolveSkillInputs(input.skills))];
}
