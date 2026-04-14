import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { skillReferenceSchema } from '../shared/skill-types.js';

export const mcpServerSchema = z.object({
	name: z.string().min(1),
	url: z.string().min(1),
});

export const phaseExecutorSchema = z.object({
	provider: z.string().min(1).optional(),
	model: z.string().min(1).optional(),
});

export const planPhaseSchema = z.object({
	...phaseExecutorSchema.shape,
	skills: z.array(skillReferenceSchema).default([]),
	instructions: z.string().optional(),
	maxReviewLoops: z.number().int().nonnegative().default(2),
});

export const planReviewPhaseSchema = z.object({
	...phaseExecutorSchema.shape,
	skills: z.array(skillReferenceSchema).default([]),
	instructions: z.string().optional(),
});

export const workPhaseSchema = z.object({
	...phaseExecutorSchema.shape,
	skills: z.array(skillReferenceSchema).default([]),
	instructions: z.string().optional(),
	maxReviewLoops: z.number().int().nonnegative().default(3),
	maxVerificationRetries: z.number().int().nonnegative().default(3),
});

export const workReviewPhaseSchema = z.object({
	...phaseExecutorSchema.shape,
	skills: z.array(skillReferenceSchema).default([]),
	instructions: z.string().optional(),
});

export const wrapupPhaseSchema = z.object({
	...phaseExecutorSchema.shape,
	skills: z.array(skillReferenceSchema).default([]),
	instructions: z.string().optional(),
});

export const verificationCommandSchema = z.object({
	name: z.string().min(1),
	command: z.string().min(1),
});

export const wrapupActionSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('git-pr'),
		required: z.boolean().default(true),
	}),
	z.object({
		type: z.literal('slack-post'),
		webhookUrl: z.string().url(),
		channel: z.string().min(1).optional(),
		required: z.boolean().default(false),
	}),
]);

export const workerConfigSchema = z.object({
	defaults: z
		.object({
			provider: z.string().min(1).default('codex'),
			model: z.string().min(1).default('latest-medium'),
		})
		.default(() => ({
			provider: 'codex',
			model: 'latest-medium',
		})),
	phases: z
		.object({
			plan: planPhaseSchema.default(() => ({
				skills: [],
				maxReviewLoops: 2,
			})),
			planReview: planReviewPhaseSchema.default(() => ({
				skills: [],
			})),
			work: workPhaseSchema.default(() => ({
				skills: [],
				maxReviewLoops: 3,
				maxVerificationRetries: 3,
			})),
			workReview: workReviewPhaseSchema.default(() => ({
				skills: [],
			})),
			wrapup: wrapupPhaseSchema.default(() => ({
				skills: [],
			})),
		})
		.default(() => ({
			plan: {
				skills: [],
				maxReviewLoops: 2,
			},
			planReview: {
				skills: [],
			},
			work: {
				skills: [],
				maxReviewLoops: 3,
				maxVerificationRetries: 3,
			},
			workReview: {
				skills: [],
			},
			wrapup: {
				skills: [],
			},
		})),
	mcpServers: z.array(mcpServerSchema).default([]),
	verification: z.array(verificationCommandSchema).default([
		{ name: 'test', command: 'npm test' },
		{ name: 'lint', command: 'npm run lint' },
	]),
	verificationTimeoutMs: z.number().positive().default(300_000),
	wrapupActions: z
		.array(wrapupActionSchema)
		.default(() => [{ type: 'git-pr' as const, required: true }]),
	branchPrefix: z.string().min(1).default('agent/'),
	commitCoAuthor: z.string().min(1).default('agent-vm-worker <noreply@agent-vm>'),
	idleTimeoutMs: z.number().positive().default(1_800_000),
	stateDir: z.string().min(1).default('/state'),
});

export type WorkerConfig = z.infer<typeof workerConfigSchema>;

const MODEL_ALIASES: Record<string, Record<string, string>> = {
	codex: {
		latest: 'gpt-5.4-high',
		'latest-medium': 'gpt-5.4-low',
		'latest-mini': 'gpt-5.4-mini',
	},
	claude: {
		latest: 'claude-opus-4-6',
		'latest-medium': 'claude-sonnet-4-6',
		'latest-mini': 'claude-haiku-4-5',
	},
};

export function resolveModelAlias(provider: string, model: string): string {
	return MODEL_ALIASES[provider]?.[model] ?? model;
}

export function resolvePhaseExecutor(
	config: WorkerConfig,
	phase: { readonly provider?: string | undefined; readonly model?: string | undefined },
): { readonly provider: string; readonly model: string } {
	const provider = phase.provider ?? config.defaults.provider;
	const model = phase.model ?? config.defaults.model;

	return {
		provider,
		model: resolveModelAlias(provider, model),
	};
}

export async function loadWorkerConfig(configPath?: string): Promise<WorkerConfig> {
	if (configPath) {
		try {
			const raw: unknown = JSON.parse(await readFile(configPath, 'utf-8'));
			return workerConfigSchema.parse(raw);
		} catch (error) {
			if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
				return workerConfigSchema.parse({});
			}
			throw error;
		}
	}

	return workerConfigSchema.parse({});
}
