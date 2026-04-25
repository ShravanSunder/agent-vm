import { describe, expect, test } from 'vitest';

import {
	DEFAULT_BUILTIN_AGENT_INSTRUCTIONS,
	DEFAULT_COMMON_AGENT_INSTRUCTIONS,
	DEFAULT_PLAN_AGENT_INSTRUCTIONS,
	DEFAULT_PLAN_REVIEWER_INSTRUCTIONS,
	DEFAULT_WORK_AGENT_INSTRUCTIONS,
	DEFAULT_WORK_REVIEWER_INSTRUCTIONS,
	DEFAULT_WRAPUP_INSTRUCTIONS,
	resolveRoleInstructions,
	type Role,
} from './prompt-defaults.js';

describe('resolveRoleInstructions', () => {
	const roles: ReadonlyArray<[Role, string]> = [
		['plan-agent', DEFAULT_PLAN_AGENT_INSTRUCTIONS],
		['plan-reviewer', DEFAULT_PLAN_REVIEWER_INSTRUCTIONS],
		['work-agent', DEFAULT_WORK_AGENT_INSTRUCTIONS],
		['work-reviewer', DEFAULT_WORK_REVIEWER_INSTRUCTIONS],
		['wrapup', DEFAULT_WRAPUP_INSTRUCTIONS],
	];

	test.each(roles)('returns default for %s when configValue is null', (role, expected) => {
		expect(resolveRoleInstructions(role, null)).toBe(expected);
	});

	test('returns custom config value when non-null', () => {
		expect(resolveRoleInstructions('plan-reviewer', 'custom')).toBe('custom');
	});

	test('returns empty string as an explicit override', () => {
		expect(resolveRoleInstructions('work-agent', '')).toBe('');
	});
});

describe('role default content', () => {
	test('built-in instructions describe runtime layers and platform boundaries', () => {
		expect(DEFAULT_BUILTIN_AGENT_INSTRUCTIONS).toContain('Instruction layers');
		expect(DEFAULT_BUILTIN_AGENT_INSTRUCTIONS).toContain('/workspace/AGENTS.md');
		expect(DEFAULT_BUILTIN_AGENT_INSTRUCTIONS).toContain('/agent-vm/agents.md');
		expect(DEFAULT_BUILTIN_AGENT_INSTRUCTIONS).toContain('/agent-vm/runtime-instructions.md');
		expect(DEFAULT_BUILTIN_AGENT_INSTRUCTIONS).toContain('/state');
		expect(DEFAULT_BUILTIN_AGENT_INSTRUCTIONS).toContain('{branchPrefix}');
		expect(DEFAULT_BUILTIN_AGENT_INSTRUCTIONS.toLowerCase()).toContain('push');
		expect(DEFAULT_BUILTIN_AGENT_INSTRUCTIONS.toLowerCase()).toContain('token');
	});

	test('common instructions describe configurable agent behavior', () => {
		expect(DEFAULT_COMMON_AGENT_INSTRUCTIONS).toContain('Package manager conventions');
		expect(DEFAULT_COMMON_AGENT_INSTRUCTIONS).toContain('runtimeInstructions');
		expect(DEFAULT_COMMON_AGENT_INSTRUCTIONS).toContain('{branchPrefix}');
		expect(DEFAULT_COMMON_AGENT_INSTRUCTIONS).not.toContain('GH_TOKEN="$GITHUB_TOKEN"');
	});

	test('built-in instructions teach Deepwiki research priority', () => {
		expect(DEFAULT_BUILTIN_AGENT_INSTRUCTIONS).toContain('## Research');
		expect(DEFAULT_BUILTIN_AGENT_INSTRUCTIONS).toContain('Deepwiki MCP');
		expect(DEFAULT_BUILTIN_AGENT_INSTRUCTIONS).toContain('ask_question');
		expect(DEFAULT_BUILTIN_AGENT_INSTRUCTIONS).toContain('NEVER');
		expect(DEFAULT_BUILTIN_AGENT_INSTRUCTIONS).toContain('read_wiki_structure');
		expect(DEFAULT_BUILTIN_AGENT_INSTRUCTIONS).toContain('read_wiki_contents');
	});

	test('built-in instructions defer project-specific research tools to project instructions', () => {
		expect(DEFAULT_BUILTIN_AGENT_INSTRUCTIONS).toContain('Project-specific research tools');
		expect(DEFAULT_BUILTIN_AGENT_INSTRUCTIONS).toContain('Project-level instructions');
	});

	test('plan-agent does not mention validation tool', () => {
		expect(DEFAULT_PLAN_AGENT_INSTRUCTIONS).not.toContain('run_validation');
	});

	test('plan-reviewer describes review schema fields', () => {
		expect(DEFAULT_PLAN_REVIEWER_INSTRUCTIONS).toContain('approved');
		expect(DEFAULT_PLAN_REVIEWER_INSTRUCTIONS).toContain('severity');
	});

	test('work-agent mentions validation tool as optional', () => {
		expect(DEFAULT_WORK_AGENT_INSTRUCTIONS).toContain('run_validation');
		expect(DEFAULT_WORK_AGENT_INSTRUCTIONS.toLowerCase()).toMatch(/may call|not required/);
	});

	test('work-reviewer must call validation tool', () => {
		expect(DEFAULT_WORK_REVIEWER_INSTRUCTIONS).toContain('run_validation');
		expect(DEFAULT_WORK_REVIEWER_INSTRUCTIONS).toContain('MUST');
	});

	test('wrapup pins the mediated PR creation flow', () => {
		expect(DEFAULT_WRAPUP_INSTRUCTIONS).toContain('## Tools');
		expect(DEFAULT_WRAPUP_INSTRUCTIONS).toContain('git-pull-default tool');
		expect(DEFAULT_WRAPUP_INSTRUCTIONS).toContain('git-push tool');
		expect(DEFAULT_WRAPUP_INSTRUCTIONS).toContain('gh CLI');
		expect(DEFAULT_WRAPUP_INSTRUCTIONS).toContain('GH_TOKEN="$GITHUB_TOKEN" gh pr create');
		expect(DEFAULT_WRAPUP_INSTRUCTIONS).toContain('Call run_validation here');
		expect(DEFAULT_WRAPUP_INSTRUCTIONS).toContain('You call git-pull-default');
		expect(DEFAULT_WRAPUP_INSTRUCTIONS).toContain('You call git-push');
		expect(DEFAULT_WRAPUP_INSTRUCTIONS).toContain('capture the GitHub PR URL');
		expect(DEFAULT_WRAPUP_INSTRUCTIONS).toContain('return JSON with prUrl');
	});
});
