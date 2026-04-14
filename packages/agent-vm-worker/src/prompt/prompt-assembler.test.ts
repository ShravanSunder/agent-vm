import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assemblePrompt, resolveSkillInputs } from './prompt-assembler.js';

describe('prompt-assembler', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'prompt-test-'));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe('resolveSkillInputs', () => {
		it('reads skill files and returns structured inputs', async () => {
			const skillDir = join(tempDir, 'skills', 'tdd');
			await mkdir(skillDir, { recursive: true });
			await writeFile(join(skillDir, 'SKILL.md'), '# TDD\nWrite tests first.', 'utf-8');

			const inputs = await resolveSkillInputs([{ name: 'tdd', path: join(skillDir, 'SKILL.md') }]);

			expect(inputs).toHaveLength(1);
			expect(inputs[0]?.type).toBe('skill');
			if (inputs[0]?.type === 'skill') {
				expect(inputs[0].name).toBe('tdd');
				expect(inputs[0].content).toContain('Write tests first.');
			}
		});

		it('skips missing skill files', async () => {
			await expect(
				resolveSkillInputs([{ name: 'missing', path: '/nonexistent/SKILL.md' }]),
			).resolves.toHaveLength(0);
		});
	});

	describe('assemblePrompt', () => {
		it('includes base prompt and default instructions', async () => {
			const result = await assemblePrompt({
				phase: 'plan',
				taskPrompt: 'fix the login bug',
				skills: [],
			});

			const text = result[0];
			expect(text?.type).toBe('text');
			if (text?.type === 'text') {
				expect(text.text).toContain('sandboxed VM');
				expect(text.text).toContain('fix the login bug');
				expect(text.text).toContain('Create an implementation plan');
			}
		});

		it('includes review JSON format for review phases', async () => {
			const result = await assemblePrompt({
				phase: 'plan-review',
				taskPrompt: 'review this',
				skills: [],
			});

			const text = result[0];
			if (text?.type === 'text') {
				expect(text.text).toContain('ReviewResult schema');
			}
		});

		it('uses custom phase instructions when provided', async () => {
			const result = await assemblePrompt({
				phase: 'plan',
				phaseInstructions: 'Custom: make a plan and include diagrams.',
				taskPrompt: 'build feature',
				skills: [],
			});

			const text = result[0];
			if (text?.type === 'text') {
				expect(text.text).toContain('Custom: make a plan');
				expect(text.text).not.toContain('Create an implementation plan');
			}
		});

		it('includes repo information when provided', async () => {
			const result = await assemblePrompt({
				phase: 'work',
				taskPrompt: 'implement feature',
				repos: [
					{
						repoUrl: 'https://github.com/org/repo.git',
						baseBranch: 'main',
						workspacePath: '/workspace/repo',
					},
				],
				skills: [],
			});

			const text = result[0];
			if (text?.type === 'text') {
				expect(text.text).toContain('github.com/org/repo.git');
				expect(text.text).toContain('branch: main');
				expect(text.text).toContain('/workspace/repo');
			}
		});

		it('includes multiple repos when provided', async () => {
			const result = await assemblePrompt({
				phase: 'work',
				taskPrompt: 'implement feature',
				repos: [
					{
						repoUrl: 'https://github.com/org/frontend.git',
						baseBranch: 'main',
						workspacePath: '/workspace/frontend',
					},
					{
						repoUrl: 'https://github.com/org/backend.git',
						baseBranch: 'develop',
						workspacePath: '/workspace/backend',
					},
				],
				skills: [],
			});

			const text = result[0];
			if (text?.type === 'text') {
				expect(text.text).toContain('https://github.com/org/frontend.git');
				expect(text.text).toContain('/workspace/frontend');
				expect(text.text).toContain('https://github.com/org/backend.git');
				expect(text.text).toContain('/workspace/backend');
			}
		});

		it('includes context when provided', async () => {
			const result = await assemblePrompt({
				phase: 'work',
				taskPrompt: 'triage alert',
				context: { alertId: 'INC-123', service: 'payments' },
				skills: [],
			});

			const text = result[0];
			if (text?.type === 'text') {
				expect(text.text).toContain('INC-123');
				expect(text.text).toContain('payments');
			}
		});

		it('includes repo summary when provided', async () => {
			const result = await assemblePrompt({
				phase: 'plan',
				taskPrompt: 'plan work',
				repoSummary: 'Repository structure (4 files):\nsrc/index.ts',
				skills: [],
			});

			const text = result[0];
			if (text?.type === 'text') {
				expect(text.text).toContain('Repository summary:');
				expect(text.text).toContain('src/index.ts');
			}
		});

		it('includes plan for work phases', async () => {
			const result = await assemblePrompt({
				phase: 'work',
				taskPrompt: 'implement',
				plan: 'Step 1: write tests\nStep 2: implement',
				skills: [],
			});

			const text = result[0];
			if (text?.type === 'text') {
				expect(text.text).toContain('Approved plan:');
				expect(text.text).toContain('Step 1: write tests');
			}
		});

		it('includes failure context for retries', async () => {
			const result = await assemblePrompt({
				phase: 'work',
				taskPrompt: 'fix bug',
				failureContext: 'Test failed: exit code 1\nassert false',
				skills: [],
			});

			const text = result[0];
			if (text?.type === 'text') {
				expect(text.text).toContain('Failure context');
				expect(text.text).toContain('assert false');
			}
		});

		it('appends skill inputs after text', async () => {
			const skillDir = join(tempDir, 'skills', 'debug');
			await mkdir(skillDir, { recursive: true });
			await writeFile(join(skillDir, 'SKILL.md'), '# Debug Skill', 'utf-8');

			const result = await assemblePrompt({
				phase: 'work',
				taskPrompt: 'debug issue',
				skills: [{ name: 'debug', path: join(skillDir, 'SKILL.md') }],
			});

			expect(result).toHaveLength(2);
			expect(result[0]?.type).toBe('text');
			expect(result[1]?.type).toBe('skill');
		});
	});
});
