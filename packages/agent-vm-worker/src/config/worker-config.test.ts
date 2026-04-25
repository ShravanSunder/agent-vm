import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	computeTotalTaskTimeoutMs,
	loadWorkerConfig,
	resolveModelAlias,
	resolvePhaseExecutor,
	workerConfigSchema,
	type WorkerConfig,
} from './worker-config.js';

function baseValidConfig(): Record<string, unknown> {
	return {
		runtimeInstructions: 'runtime facts',
		commonAgentInstructions: null,
		defaults: { provider: 'codex', model: 'latest-medium' },
		phases: {
			plan: {
				cycle: { kind: 'review', cycleCount: 2 },
				agentInstructions: null,
				reviewerInstructions: null,
				skills: [],
			},
			work: {
				cycle: { kind: 'review', cycleCount: 4 },
				agentInstructions: null,
				reviewerInstructions: null,
				skills: [],
			},
			wrapup: { instructions: null, skills: [] },
		},
		mcpServers: [],
		verification: [],
		verificationTimeoutMs: 300_000,
		branchPrefix: 'agent/',
		stateDir: '/state',
	};
}

describe('worker-config', () => {
	describe('workerConfigSchema', () => {
		it('accepts valid config with null role instructions', () => {
			const config = workerConfigSchema.parse(baseValidConfig());

			expect(config.runtimeInstructions).toBe('runtime facts');
			expect(config.commonAgentInstructions).toBeNull();
			expect(config.phases.plan.agentInstructions).toBeNull();
			expect(config.phases.work.reviewerInstructions).toBeNull();
			expect(config.phases.wrapup.instructions).toBeNull();
			expect(config.phases.plan.agentTurnTimeoutMs).toBe(900_000);
			expect(config.phases.work.agentTurnTimeoutMs).toBe(2_700_000);
		});

		it('accepts per-role instruction overrides', () => {
			const input = baseValidConfig();
			const phases = input.phases as {
				plan: { agentInstructions: string | null; reviewerInstructions: string | null };
				work: { agentInstructions: string | null; reviewerInstructions: string | null };
				wrapup: { instructions: string | null };
			};
			phases.plan.agentInstructions = 'plan agent';
			phases.plan.reviewerInstructions = 'plan reviewer';
			phases.work.agentInstructions = 'work agent';
			phases.work.reviewerInstructions = 'work reviewer';
			phases.wrapup.instructions = 'wrapup';

			expect(workerConfigSchema.safeParse(input).success).toBe(true);
		});

		it('accepts final runtime and common agent instructions', () => {
			const input = baseValidConfig();
			input.runtimeInstructions = 'runtime facts from controller';
			input.commonAgentInstructions = 'common behavior';

			const config = workerConfigSchema.parse(input);

			expect(config.runtimeInstructions).toBe('runtime facts from controller');
			expect(config.commonAgentInstructions).toBe('common behavior');
		});

		it('requires runtime instructions in the final worker config', () => {
			const input = baseValidConfig();
			delete input.runtimeInstructions;

			expect(() => workerConfigSchema.parse(input)).toThrow(/runtimeInstructions/u);
		});

		it('rejects empty runtime instructions in the final worker config', () => {
			const input = baseValidConfig();
			input.runtimeInstructions = '';

			expect(workerConfigSchema.safeParse(input).success).toBe(false);
		});

		it('does not accept legacy instructions', () => {
			const input = baseValidConfig();
			input.instructions = 'legacy base instructions';

			expect(() => workerConfigSchema.parse(input)).toThrow();
		});

		it('rejects instruction arrays', () => {
			const input = baseValidConfig();
			input.commonAgentInstructions = ['base line 1', 'base line 2'];

			expect(workerConfigSchema.safeParse(input).success).toBe(false);
		});

		it('rejects missing required nullable instruction keys', () => {
			const input = baseValidConfig();
			const phases = input.phases as { plan: { agentInstructions?: string | null } };
			delete phases.plan.agentInstructions;

			expect(workerConfigSchema.safeParse(input).success).toBe(false);
		});

		it('rejects old phase shape', () => {
			const input = {
				...baseValidConfig(),
				phases: {
					plan: { skills: [], maxReviewLoops: 1 },
					planReview: { skills: [] },
					work: { skills: [], maxReviewLoops: 1, maxVerificationRetries: 1 },
					workReview: { skills: [] },
					wrapup: { skills: [] },
				},
			};

			expect(workerConfigSchema.safeParse(input).success).toBe(false);
		});

		it('rejects work.cycle.kind=noReview but accepts plan.cycle.kind=noReview', () => {
			const invalid = baseValidConfig();
			(invalid.phases as { work: { cycle: unknown } }).work.cycle = { kind: 'noReview' };

			const valid = baseValidConfig();
			(valid.phases as { plan: { cycle: unknown } }).plan.cycle = { kind: 'noReview' };

			expect(workerConfigSchema.safeParse(invalid).success).toBe(false);
			expect(workerConfigSchema.safeParse(valid).success).toBe(true);
		});

		it('rejects work.cycle.cycleCount=0 (minimum 1)', () => {
			const invalid = baseValidConfig();
			(invalid.phases as { work: { cycle: { kind: string; cycleCount: number } } }).work.cycle = {
				kind: 'review',
				cycleCount: 0,
			};

			expect(workerConfigSchema.safeParse(invalid).success).toBe(false);
		});

		it('rejects legacy wrapupActions', () => {
			expect(
				workerConfigSchema.safeParse({
					...baseValidConfig(),
					wrapupActions: [{ type: 'git-pr', required: true }],
				}).success,
			).toBe(false);
		});

		it('accepts mcpServer entry without bearerTokenEnvVar', () => {
			const result = workerConfigSchema.safeParse({
				...baseValidConfig(),
				mcpServers: [{ name: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp' }],
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.mcpServers[0]?.bearerTokenEnvVar).toBeUndefined();
			}
		});

		it('accepts mcpServer entry with bearerTokenEnvVar', () => {
			const result = workerConfigSchema.safeParse({
				...baseValidConfig(),
				mcpServers: [
					{
						name: 'internal-docs',
						url: 'https://docs.example.test/mcp',
						bearerTokenEnvVar: 'INTERNAL_DOCS_TOKEN',
					},
				],
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.mcpServers[0]?.bearerTokenEnvVar).toBe('INTERNAL_DOCS_TOKEN');
			}
		});

		it('rejects empty bearerTokenEnvVar', () => {
			const result = workerConfigSchema.safeParse({
				...baseValidConfig(),
				mcpServers: [
					{ name: 'internal-docs', url: 'https://docs.example.test/mcp', bearerTokenEnvVar: '' },
				],
			});
			expect(result.success).toBe(false);
		});
	});

	describe('resolveModelAlias', () => {
		it('resolves codex latest-medium to gpt-5.4 with low effort', () => {
			expect(resolveModelAlias('codex', 'latest-medium')).toEqual({
				model: 'gpt-5.4',
				reasoningEffort: 'low',
			});
		});

		it('passes through explicit model IDs with medium effort', () => {
			expect(resolveModelAlias('codex', 'gpt-5.4-turbo')).toEqual({
				model: 'gpt-5.4-turbo',
				reasoningEffort: 'medium',
			});
		});
	});

	describe('resolvePhaseExecutor', () => {
		it('uses defaults when phase has no overrides', () => {
			const config = workerConfigSchema.parse(baseValidConfig());

			expect(resolvePhaseExecutor(config, {})).toEqual({
				provider: 'codex',
				model: 'gpt-5.4',
				reasoningEffort: 'low',
			});
		});

		it('uses phase overrides when provided', () => {
			const config = workerConfigSchema.parse(baseValidConfig()) satisfies WorkerConfig;

			expect(resolvePhaseExecutor(config, { provider: 'claude', model: 'latest' })).toEqual({
				provider: 'claude',
				model: 'claude-opus-4-6',
				reasoningEffort: 'high',
			});
		});
	});

	describe('loadWorkerConfig', () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), 'worker-config-test-'));
		});

		afterEach(async () => {
			await rm(tempDir, { recursive: true, force: true });
		});

		it('loads and parses config from a file', async () => {
			const configPath = join(tempDir, 'worker.json');
			await writeFile(configPath, JSON.stringify(baseValidConfig()), 'utf-8');

			const config = await loadWorkerConfig(configPath);

			expect(config.defaults.provider).toBe('codex');
		});

		it('loads instruction file references relative to the config file', async () => {
			const configPath = join(tempDir, 'nested', 'worker.json');
			const promptDir = join(tempDir, 'nested', 'prompts');
			await mkdir(promptDir, { recursive: true });
			await writeFile(
				join(promptDir, 'common-agent-instructions.md'),
				'base line 1\nbase line 2\n',
				'utf-8',
			);
			await writeFile(join(promptDir, 'plan-agent.md'), 'plan agent\n', 'utf-8');
			const rawConfig = baseValidConfig();
			rawConfig.commonAgentInstructions = { path: './prompts/common-agent-instructions.md' };
			(
				rawConfig.phases as {
					plan: { agentInstructions: unknown };
				}
			).plan.agentInstructions = { path: './prompts/plan-agent.md' };
			await writeFile(configPath, JSON.stringify(rawConfig), 'utf-8');

			const config = await loadWorkerConfig(configPath);

			expect(config.commonAgentInstructions).toBe('base line 1\nbase line 2\n');
			expect(config.phases.plan.agentInstructions).toBe('plan agent\n');
		});

		it('fails fast when an instruction file reference is missing', async () => {
			const configPath = join(tempDir, 'worker.json');
			const rawConfig = baseValidConfig();
			rawConfig.commonAgentInstructions = { path: './prompts/missing.md' };
			await writeFile(configPath, JSON.stringify(rawConfig), 'utf-8');

			await expect(loadWorkerConfig(configPath)).rejects.toThrow(
				/commonAgentInstructions.*prompts\/missing\.md/u,
			);
		});

		it('rejects absolute instruction file references', async () => {
			const configPath = join(tempDir, 'worker.json');
			const rawConfig = baseValidConfig();
			rawConfig.commonAgentInstructions = { path: join(tempDir, 'prompts', 'base.md') };
			await writeFile(configPath, JSON.stringify(rawConfig), 'utf-8');

			await expect(loadWorkerConfig(configPath)).rejects.toThrow(/must be relative/u);
		});

		it('rejects instruction file references outside the prompts directory', async () => {
			const configPath = join(tempDir, 'worker.json');
			await writeFile(join(tempDir, 'outside.md'), 'outside\n', 'utf-8');
			const rawConfig = baseValidConfig();
			rawConfig.commonAgentInstructions = { path: './outside.md' };
			await writeFile(configPath, JSON.stringify(rawConfig), 'utf-8');

			await expect(loadWorkerConfig(configPath)).rejects.toThrow(/must stay under '\.\/prompts'/u);
		});

		it('rejects symlink instruction file references that escape prompts', async () => {
			const configPath = join(tempDir, 'worker.json');
			const promptDir = join(tempDir, 'prompts');
			await mkdir(promptDir, { recursive: true });
			await writeFile(join(tempDir, 'outside.md'), 'outside\n', 'utf-8');
			await symlink(join(tempDir, 'outside.md'), join(promptDir, 'escaped.md'));
			const rawConfig = baseValidConfig();
			rawConfig.commonAgentInstructions = { path: './prompts/escaped.md' };
			await writeFile(configPath, JSON.stringify(rawConfig), 'utf-8');

			await expect(loadWorkerConfig(configPath)).rejects.toThrow(/escapes/u);
		});

		it('returns built-in config when no config path is provided', async () => {
			const config = await loadWorkerConfig();

			expect(config.phases.plan.agentInstructions).toBeNull();
			expect(config.phases.work.cycle).toEqual({ kind: 'review', cycleCount: 4 });
			expect(config.phases.wrapup.instructions).toBeNull();
		});

		it('throws when a configured file does not exist', async () => {
			await expect(loadWorkerConfig(join(tempDir, 'missing.json'))).rejects.toThrow();
		});
	});

	describe('computeTotalTaskTimeoutMs', () => {
		it('sums review-cycle phases with 10% buffer', () => {
			// Arrange: default config — plan 2 cycles, work 4 cycles.
			const config = workerConfigSchema.parse(baseValidConfig());

			// Act
			const total = computeTotalTaskTimeoutMs(config);

			// Assert: plan = (2+1)*900 + 2*900 = 4500. work = (4+1)*2700 + 4*900 = 17100.
			//         wrapup = 900. sum = 22500. + 10% = 24750 (× 1000 ms).
			expect(total).toBe(24_750_000);
		});

		it('handles noReview plan phase', () => {
			// Arrange
			const raw = baseValidConfig();
			(raw.phases as { plan: { cycle: unknown } }).plan.cycle = { kind: 'noReview' };
			const config = workerConfigSchema.parse(raw);

			// Act
			const total = computeTotalTaskTimeoutMs(config);

			// Assert: plan = 900 (single agent turn). work = 17100. wrapup = 900. + 10%.
			expect(total).toBe(20_790_000);
		});

		it('scales with larger cycle counts', () => {
			// Arrange: push work to 5 cycles — worst case grows linearly.
			const raw = baseValidConfig();
			(raw.phases as { work: { cycle: { kind: string; cycleCount: number } } }).work.cycle = {
				kind: 'review',
				cycleCount: 5,
			};
			const config = workerConfigSchema.parse(raw);

			// Act
			const total = computeTotalTaskTimeoutMs(config);

			// Assert: plan = 4500. work = (5+1)*2700 + 5*900 = 20700. wrapup = 900.
			//         sum = 26100. + 10% = 28_710_000.
			expect(total).toBe(28_710_000);
		});
	});
});
