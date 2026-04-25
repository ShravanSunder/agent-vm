import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { buildRoleSystemPrompt } from './prompt-assembler.js';

describe('buildRoleSystemPrompt', () => {
	const tmpDirs: string[] = [];

	afterEach(async () => {
		const dirs = tmpDirs.splice(0);
		await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
	});

	test('composes base and role-specific defaults with branchPrefix', async () => {
		const output = await buildRoleSystemPrompt({
			role: 'plan-agent',
			baseInstructionsOverride: null,
			roleInstructionsOverride: null,
			branchPrefix: 'feat/',
			skills: [],
		});

		expect(output).toContain('feat/');
		expect(output.toLowerCase()).toContain('plan');
	});

	test('honors base and role overrides', async () => {
		const output = await buildRoleSystemPrompt({
			role: 'work-agent',
			baseInstructionsOverride: 'BASE {branchPrefix}',
			roleInstructionsOverride: 'ROLE',
			branchPrefix: 'agent/',
			skills: [],
		});

		expect(output).toContain('BASE agent/');
		expect(output).toContain('ROLE');
	});

	test('appends skill content when skills are provided', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'prompt-skill-'));
		tmpDirs.push(dir);
		const skillPath = join(dir, 'skill.md');
		await writeFile(skillPath, 'Skill body', 'utf-8');

		const output = await buildRoleSystemPrompt({
			role: 'work-reviewer',
			baseInstructionsOverride: null,
			roleInstructionsOverride: null,
			branchPrefix: 'agent/',
			skills: [{ name: 'review-skill', path: skillPath }],
		});

		expect(output).toContain('## Skill: review-skill');
		expect(output).toContain('Skill body');
	});

	test('skips missing skills but throws on unreadable skill paths', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'prompt-skill-dir-'));
		tmpDirs.push(dir);

		const output = await buildRoleSystemPrompt({
			role: 'plan-agent',
			baseInstructionsOverride: null,
			roleInstructionsOverride: null,
			branchPrefix: 'agent/',
			skills: [{ name: 'missing-skill', path: join(dir, 'missing.md') }],
		});
		expect(output).not.toContain('missing-skill');

		await expect(
			buildRoleSystemPrompt({
				role: 'plan-agent',
				baseInstructionsOverride: null,
				roleInstructionsOverride: null,
				branchPrefix: 'agent/',
				skills: [{ name: 'directory-skill', path: dir }],
			}),
		).rejects.toThrow(/Skill load failed/);
	});
});
