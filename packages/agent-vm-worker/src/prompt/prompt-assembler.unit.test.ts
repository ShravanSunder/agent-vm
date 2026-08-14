import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configure, dispose, reset, type LogRecord } from '@logtape/logtape';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { buildRoleSystemPrompt } from './prompt-assembler.js';

describe('buildRoleSystemPrompt', () => {
	const tmpDirs: string[] = [];
	const capturedRecords: LogRecord[] = [];

	beforeEach(async () => {
		capturedRecords.length = 0;
		await configure({
			loggers: [
				{
					category: ['agent-vm', 'worker', 'coordinator'],
					lowestLevel: 'trace',
					sinks: ['capture'],
				},
				{
					category: ['logtape', 'meta'],
					lowestLevel: 'error',
					sinks: ['capture'],
				},
			],
			reset: true,
			sinks: {
				capture: (record): void => {
					capturedRecords.push(record);
				},
			},
		});
	});

	afterEach(async () => {
		const dirs = tmpDirs.splice(0);
		await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
		await dispose().catch(() => {});
		await reset();
	});

	test('composes base and role-specific defaults with branchPrefix', async () => {
		const output = await buildRoleSystemPrompt({
			role: 'plan-agent',
			runtimeInstructions: 'RUNTIME',
			commonAgentInstructionsOverride: null,
			roleInstructionsOverride: null,
			branchPrefix: 'feat/',
			skills: [],
		});

		expect(output).toContain('RUNTIME');
		expect(output).toContain('feat/');
		expect(output.toLowerCase()).toContain('plan');
	});

	test('rejects empty runtime instructions', async () => {
		await expect(
			buildRoleSystemPrompt({
				role: 'plan-agent',
				runtimeInstructions: '',
				commonAgentInstructionsOverride: null,
				roleInstructionsOverride: null,
				branchPrefix: 'feat/',
				skills: [],
			}),
		).rejects.toThrow(/runtimeInstructions/u);
	});

	test('honors common and role overrides', async () => {
		const output = await buildRoleSystemPrompt({
			role: 'work-agent',
			runtimeInstructions: 'RUNTIME',
			commonAgentInstructionsOverride: 'COMMON {branchPrefix}',
			roleInstructionsOverride: 'ROLE',
			branchPrefix: 'agent/',
			skills: [],
		});

		expect(output).toContain('RUNTIME');
		expect(output).toContain('COMMON agent/');
		expect(output).toContain('ROLE');
	});

	test('orders runtime, built-in, common, role, and skills', async () => {
		const output = await buildRoleSystemPrompt({
			role: 'work-agent',
			runtimeInstructions: 'RUNTIME',
			commonAgentInstructionsOverride: 'COMMON',
			roleInstructionsOverride: 'ROLE',
			branchPrefix: 'agent/',
			skills: [],
		});

		expect(output).toMatch(/RUNTIME[\s\S]*## Instruction layers[\s\S]*COMMON[\s\S]*ROLE/u);
	});

	test('appends skill content when skills are provided', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'prompt-skill-'));
		tmpDirs.push(dir);
		const skillPath = join(dir, 'skill.md');
		await writeFile(skillPath, 'Skill body', 'utf-8');

		const output = await buildRoleSystemPrompt({
			role: 'work-reviewer',
			runtimeInstructions: 'RUNTIME',
			commonAgentInstructionsOverride: null,
			roleInstructionsOverride: null,
			branchPrefix: 'agent/',
			skills: [{ name: 'review-skill', path: skillPath }],
		});

		expect(output).toContain('## Skill: review-skill');
		expect(output).toContain('Skill body');
	});

	test('skips a missing skill and emits a filterable event', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'prompt-skill-dir-'));
		tmpDirs.push(dir);

		const output = await buildRoleSystemPrompt({
			role: 'plan-agent',
			runtimeInstructions: 'RUNTIME',
			commonAgentInstructionsOverride: null,
			roleInstructionsOverride: null,
			branchPrefix: 'agent/',
			skills: [{ name: 'missing-skill', path: join(dir, 'missing.md') }],
		});
		expect(output).not.toContain('missing-skill');
		expect(capturedRecords.at(-1)?.properties).toMatchObject({
			event: 'instruction-skill-not-found',
			failureClass: 'unavailable',
		});
	});

	test('throws for an unreadable skill path and emits a filterable event', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'prompt-skill-dir-'));
		tmpDirs.push(dir);

		await expect(
			buildRoleSystemPrompt({
				role: 'plan-agent',
				runtimeInstructions: 'RUNTIME',
				commonAgentInstructionsOverride: null,
				roleInstructionsOverride: null,
				branchPrefix: 'agent/',
				skills: [{ name: 'directory-skill', path: dir }],
			}),
		).rejects.toThrow(/Skill load failed/);
		expect(capturedRecords.at(-1)?.properties).toMatchObject({
			event: 'instruction-skill-load-failed',
			failureClass: 'load-failed',
		});
	});
});
