import type { PhaseName } from '../state/task-event-types.js';

export const DEFAULT_BASE_INSTRUCTIONS = `## Git Rules
- You may commit at any time using git add and git commit.
- Always commit to a branch prefixed with "agent/" - never commit to main or master.
- Do NOT run git push. Push is handled by the system after wrapup.
- Do NOT modify or delete the .git directory.
- Use conventional commit messages: "feat:", "fix:", "refactor:", "test:", "docs:".

## Workspace Rules
- Work only inside the workspace directories provided in the task repos.
- Do not create files outside the workspace.
- Do not modify system files or configuration outside the workspace.

## Verification
- Run verification commands before requesting wrapup.
- If verification fails, fix the issue and re-verify.

## Wrapup
- When work is complete and verified, call the git-pr tool to stage, commit, and request controller-side push and PR creation.
- The git-pr tool handles the controller handoff - you only need to provide the title and description.`;

export const DEFAULT_PHASE_INSTRUCTIONS = {
	plan: 'Create an implementation plan for the task. Do not write code yet.',
	'plan-review': 'Review the plan for completeness, correctness, risks, and missing edge cases.',
	work: 'Implement the approved plan.',
	'work-review': 'Review the code changes for correctness, bugs, style, and test coverage.',
	wrapup:
		'Complete the task by running the configured wrapup actions. You have access to: ' +
		'git (commit, push, PR), Slack (webhook post). Decide which actions to take based on the task results.',
} as const satisfies Partial<Record<PhaseName, string>>;

export function getDefaultPhaseInstruction(phase: PhaseName): string | undefined {
	const defaultPhaseInstructionsByPhase: Partial<Record<PhaseName, string>> =
		DEFAULT_PHASE_INSTRUCTIONS;
	return defaultPhaseInstructionsByPhase[phase];
}
