import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
	DEFAULT_COMMON_AGENT_INSTRUCTIONS,
	DEFAULT_PLAN_AGENT_INSTRUCTIONS,
	DEFAULT_PLAN_REVIEWER_INSTRUCTIONS,
	DEFAULT_WORK_AGENT_INSTRUCTIONS,
	DEFAULT_WORK_REVIEWER_INSTRUCTIONS,
	DEFAULT_WRAPUP_INSTRUCTIONS,
	loadWorkerConfigDraft,
	workerConfigSchema,
} from '@agent-vm/agent-vm-worker';
import { describe, expect, it } from 'vitest';

import { resetWorkerInstructions } from './config-commands.js';

async function writeWorkerConfig(filePath: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(
		filePath,
		`${JSON.stringify(
			workerConfigSchema.parse({
				runtimeInstructions: 'runtime facts',
				commonAgentInstructions: 'custom common',
				phases: {
					plan: {
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: 'custom plan agent',
						reviewerInstructions: 'custom plan reviewer',
					},
					work: {
						cycle: { kind: 'review', cycleCount: 2 },
						agentInstructions: 'custom work agent',
						reviewerInstructions: 'custom work reviewer',
					},
					wrapup: {
						instructions: 'custom wrapup',
					},
				},
			}),
			null,
			'\t',
		)}\n`,
		'utf8',
	);
}

describe('resetWorkerInstructions', () => {
	it('resets all instruction fields and preserves non-instruction fields', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-config-'));
		const workerConfigPath = path.join(temporaryDirectoryPath, 'worker.json');
		await writeWorkerConfig(workerConfigPath);

		const result = await resetWorkerInstructions({
			workerConfigPath,
			phase: 'all',
		});

		const parsed = workerConfigSchema.parse(
			JSON.parse(await fs.readFile(workerConfigPath, 'utf8')),
		);
		expect(parsed.commonAgentInstructions).toBe(DEFAULT_COMMON_AGENT_INSTRUCTIONS);
		expect(parsed.phases.plan.agentInstructions).toBe(DEFAULT_PLAN_AGENT_INSTRUCTIONS);
		expect(parsed.phases.plan.reviewerInstructions).toBe(DEFAULT_PLAN_REVIEWER_INSTRUCTIONS);
		expect(parsed.phases.work.agentInstructions).toBe(DEFAULT_WORK_AGENT_INSTRUCTIONS);
		expect(parsed.phases.work.reviewerInstructions).toBe(DEFAULT_WORK_REVIEWER_INSTRUCTIONS);
		expect(parsed.phases.wrapup.instructions).toBe(DEFAULT_WRAPUP_INSTRUCTIONS);
		expect(parsed.phases.work.cycle).toEqual({ kind: 'review', cycleCount: 2 });
		expect(result.changed).toEqual([
			'commonAgentInstructions',
			'phases.plan.agentInstructions',
			'phases.plan.reviewerInstructions',
			'phases.work.agentInstructions',
			'phases.work.reviewerInstructions',
			'phases.wrapup.instructions',
		]);
	});

	it('resets only the selected phase', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-config-'));
		const workerConfigPath = path.join(temporaryDirectoryPath, 'worker.json');
		await writeWorkerConfig(workerConfigPath);

		await resetWorkerInstructions({
			workerConfigPath,
			phase: 'wrapup',
		});

		const parsed = workerConfigSchema.parse(
			JSON.parse(await fs.readFile(workerConfigPath, 'utf8')),
		);
		expect(parsed.commonAgentInstructions).toBe('custom common');
		expect(parsed.phases.plan.agentInstructions).toBe('custom plan agent');
		expect(parsed.phases.work.agentInstructions).toBe('custom work agent');
		expect(parsed.phases.wrapup.instructions).toBe(DEFAULT_WRAPUP_INSTRUCTIONS);
	});

	it('resets configs that use prompt file references', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-config-'));
		const workerConfigPath = path.join(temporaryDirectoryPath, 'worker.json');
		await fs.mkdir(path.join(temporaryDirectoryPath, 'prompts'), { recursive: true });
		await fs.writeFile(
			path.join(temporaryDirectoryPath, 'prompts', 'common-agent-instructions.md'),
			'custom common\n',
		);
		await fs.writeFile(
			workerConfigPath,
			`${JSON.stringify(
				{
					commonAgentInstructions: { path: './prompts/common-agent-instructions.md' },
					phases: {
						plan: {
							cycle: { kind: 'review', cycleCount: 1 },
							agentInstructions: 'custom plan agent',
							reviewerInstructions: 'custom plan reviewer',
						},
						work: {
							cycle: { kind: 'review', cycleCount: 2 },
							agentInstructions: 'custom work agent',
							reviewerInstructions: 'custom work reviewer',
						},
						wrapup: {
							instructions: 'custom wrapup',
						},
					},
				},
				null,
				'\t',
			)}\n`,
			'utf8',
		);

		await resetWorkerInstructions({
			workerConfigPath,
			phase: 'all',
		});

		const rawConfig = JSON.parse(await fs.readFile(workerConfigPath, 'utf8')) as {
			readonly commonAgentInstructions: { readonly path: string };
		};
		const parsed = await loadWorkerConfigDraft(workerConfigPath);
		expect(rawConfig.commonAgentInstructions).toEqual({
			path: './prompts/common-agent-instructions.md',
		});
		expect(parsed.commonAgentInstructions).toBe(`${DEFAULT_COMMON_AGENT_INSTRUCTIONS}\n`);
		expect(parsed.phases.plan.agentInstructions).toBe(DEFAULT_PLAN_AGENT_INSTRUCTIONS);
	});

	it('preserves non-targeted prompt file references during partial resets', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-config-'));
		const workerConfigPath = path.join(temporaryDirectoryPath, 'worker.json');
		const promptDirectoryPath = path.join(temporaryDirectoryPath, 'prompts');
		await fs.mkdir(promptDirectoryPath, { recursive: true });
		await fs.writeFile(
			path.join(promptDirectoryPath, 'common-agent-instructions.md'),
			'custom common\n',
		);
		await fs.writeFile(path.join(promptDirectoryPath, 'plan-agent.md'), 'custom plan agent\n');
		await fs.writeFile(
			path.join(promptDirectoryPath, 'plan-reviewer.md'),
			'custom plan reviewer\n',
		);
		await fs.writeFile(path.join(promptDirectoryPath, 'work-agent.md'), 'custom work agent\n');
		await fs.writeFile(
			path.join(promptDirectoryPath, 'work-reviewer.md'),
			'custom work reviewer\n',
		);
		await fs.writeFile(path.join(promptDirectoryPath, 'wrapup.md'), 'custom wrapup\n');
		const rawConfig = {
			commonAgentInstructions: { path: './prompts/common-agent-instructions.md' },
			phases: {
				plan: {
					cycle: { kind: 'review', cycleCount: 1 },
					agentInstructions: { path: './prompts/plan-agent.md' },
					reviewerInstructions: { path: './prompts/plan-reviewer.md' },
				},
				work: {
					cycle: { kind: 'review', cycleCount: 2 },
					agentInstructions: { path: './prompts/work-agent.md' },
					reviewerInstructions: { path: './prompts/work-reviewer.md' },
				},
				wrapup: {
					instructions: { path: './prompts/wrapup.md' },
				},
			},
		};
		await fs.writeFile(workerConfigPath, `${JSON.stringify(rawConfig, null, '\t')}\n`, 'utf8');

		await resetWorkerInstructions({
			workerConfigPath,
			phase: 'wrapup',
		});

		const updatedRawConfig = JSON.parse(
			await fs.readFile(workerConfigPath, 'utf8'),
		) as typeof rawConfig;
		expect(updatedRawConfig.commonAgentInstructions).toEqual({
			path: './prompts/common-agent-instructions.md',
		});
		expect(updatedRawConfig.phases.plan.agentInstructions).toEqual({
			path: './prompts/plan-agent.md',
		});
		expect(updatedRawConfig.phases.work.reviewerInstructions).toEqual({
			path: './prompts/work-reviewer.md',
		});
		expect(updatedRawConfig.phases.wrapup.instructions).toEqual({ path: './prompts/wrapup.md' });
		await expect(
			fs.readFile(path.join(promptDirectoryPath, 'common-agent-instructions.md'), 'utf8'),
		).resolves.toBe('custom common\n');
		await expect(fs.readFile(path.join(promptDirectoryPath, 'wrapup.md'), 'utf8')).resolves.toBe(
			`${DEFAULT_WRAPUP_INSTRUCTIONS}\n`,
		);
	});
});
