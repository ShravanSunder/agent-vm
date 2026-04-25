import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

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

// Cycle semantics:
//   noReview:  just <agent>                                    1 turn
//   review:    <agent> → review → <agent>   × cycleCount       1 + 2N turns
//
// A "cycle" always ENDS on the agent's revise turn, so reviewer feedback
// always reaches the agent. plan accepts both shapes; work must always
// include review (minimum 1 cycle).

const noReviewCycleSchema = z.object({
	kind: z.literal('noReview'),
});

const reviewCycleSchema = z.object({
	kind: z.literal('review'),
	cycleCount: z.number().int().min(1),
});

const planCycleSchema = z.discriminatedUnion('kind', [noReviewCycleSchema, reviewCycleSchema]);

// work can never be noReview — minimum 1 cycle enforced by schema
const workCycleSchema = reviewCycleSchema;

export type PlanCycleConfig = z.infer<typeof planCycleSchema>;
export type WorkCycleConfig = z.infer<typeof workCycleSchema>;

const instructionTextSchema = z.string();

const nullableInstructionTextSchema = z.union([instructionTextSchema, z.null()]);

const instructionFileReferenceSchema = z
	.object({
		path: z.string().min(1),
	})
	.strict();

const instructionInputSchema = z.union([instructionTextSchema, instructionFileReferenceSchema]);
const nullableInstructionInputSchema = z.union([instructionInputSchema, z.null()]);

type NullableInstructionInput = z.infer<typeof nullableInstructionInputSchema>;

export const planPhaseSchema = z.object({
	...phaseExecutorSchema.shape,
	cycle: planCycleSchema,
	agentInstructions: nullableInstructionTextSchema,
	reviewerInstructions: nullableInstructionTextSchema,
	agentTurnTimeoutMs: z
		.number()
		.int()
		.positive()
		.default(15 * 60_000),
	reviewerTurnTimeoutMs: z
		.number()
		.int()
		.positive()
		.default(15 * 60_000),
	skills: z.array(skillReferenceSchema).default([]),
});

export const workPhaseSchema = z.object({
	...phaseExecutorSchema.shape,
	cycle: workCycleSchema,
	agentInstructions: nullableInstructionTextSchema,
	reviewerInstructions: nullableInstructionTextSchema,
	agentTurnTimeoutMs: z
		.number()
		.int()
		.positive()
		.default(45 * 60_000),
	reviewerTurnTimeoutMs: z
		.number()
		.int()
		.positive()
		.default(15 * 60_000),
	skills: z.array(skillReferenceSchema).default([]),
});

export const wrapupPhaseSchema = z.object({
	...phaseExecutorSchema.shape,
	instructions: nullableInstructionTextSchema,
	turnTimeoutMs: z
		.number()
		.int()
		.positive()
		.default(15 * 60_000),
	skills: z.array(skillReferenceSchema).default([]),
});

const phasesSchema = z
	.object({
		plan: planPhaseSchema,
		work: workPhaseSchema,
		wrapup: wrapupPhaseSchema,
	})
	.strict();

export const verificationCommandSchema = z.object({
	name: z.string().min(1),
	command: z.string().min(1),
});

export const workerConfigSchema = z
	.object({
		instructions: nullableInstructionTextSchema.optional(),
		defaults: z
			.object({
				provider: z.string().min(1).default('codex'),
				model: z.string().min(1).default('latest-medium'),
			})
			.default(() => ({
				provider: 'codex',
				model: 'latest-medium',
			})),
		phases: phasesSchema,
		mcpServers: z.array(mcpServerSchema).default([]),
		verification: z.array(verificationCommandSchema).default([]),
		verificationTimeoutMs: z.number().positive().default(300_000),
		branchPrefix: z.string().min(1).default('agent/'),
		stateDir: z.string().min(1).default('/state'),
	})
	.strict();

export type PlanPhaseConfig = z.infer<typeof planPhaseSchema>;
export type WorkPhaseConfig = z.infer<typeof workPhaseSchema>;
export type WrapupPhaseConfig = z.infer<typeof wrapupPhaseSchema>;
export type WorkerConfig = z.infer<typeof workerConfigSchema>;

const TOTAL_TIMEOUT_BUFFER_PERCENT = 10;

function phaseWorstCaseMs(phase: PlanPhaseConfig | WorkPhaseConfig): number {
	if (phase.cycle.kind === 'noReview') {
		return phase.agentTurnTimeoutMs;
	}
	const cycles = phase.cycle.cycleCount;
	return (cycles + 1) * phase.agentTurnTimeoutMs + cycles * phase.reviewerTurnTimeoutMs;
}

export function computeTotalTaskTimeoutMs(config: WorkerConfig): number {
	const planMs = phaseWorstCaseMs(config.phases.plan);
	const workMs = phaseWorstCaseMs(config.phases.work);
	const wrapupMs = config.phases.wrapup.turnTimeoutMs;
	const baseMs = planMs + workMs + wrapupMs;
	return baseMs + Math.ceil((baseMs * TOTAL_TIMEOUT_BUFFER_PERCENT) / 100);
}

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

interface ResolvedModel {
	readonly model: string;
	readonly reasoningEffort: ReasoningEffort;
}

const MODEL_ALIASES: Record<string, Record<string, ResolvedModel>> = {
	codex: {
		latest: { model: 'gpt-5.4', reasoningEffort: 'high' },
		'latest-medium': { model: 'gpt-5.4', reasoningEffort: 'low' },
		'latest-mini': { model: 'gpt-5.4-mini', reasoningEffort: 'medium' },
	},
	claude: {
		latest: { model: 'claude-opus-4-6', reasoningEffort: 'high' },
		'latest-medium': { model: 'claude-sonnet-4-6', reasoningEffort: 'medium' },
		'latest-mini': { model: 'claude-haiku-4-5', reasoningEffort: 'medium' },
	},
};

export function resolveModelAlias(provider: string, model: string): ResolvedModel {
	return MODEL_ALIASES[provider]?.[model] ?? { model, reasoningEffort: 'medium' };
}

export function resolvePhaseExecutor(
	config: WorkerConfig,
	phase: { readonly provider?: string | undefined; readonly model?: string | undefined },
): {
	readonly provider: string;
	readonly model: string;
	readonly reasoningEffort: ReasoningEffort;
} {
	const provider = phase.provider ?? config.defaults.provider;
	const model = phase.model ?? config.defaults.model;
	const resolved = resolveModelAlias(provider, model);

	return {
		provider,
		model: resolved.model,
		reasoningEffort: resolved.reasoningEffort,
	};
}

function buildDefaultWorkerConfigInput(): Record<string, unknown> {
	return {
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
	};
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readInstructionReference(
	reference: { readonly path: string },
	configDir: string,
	fieldPath: string,
): Promise<string> {
	if (path.isAbsolute(reference.path)) {
		throw new Error(
			`Invalid worker config ${fieldPath}: prompt file path must be relative to ./prompts.`,
		);
	}

	const promptsRootPath = path.resolve(configDir, 'prompts');
	const filePath = path.resolve(configDir, reference.path);
	const relativeToPromptsRoot = path.relative(promptsRootPath, filePath);
	if (relativeToPromptsRoot.startsWith('..') || path.isAbsolute(relativeToPromptsRoot)) {
		throw new Error(
			`Invalid worker config ${fieldPath}: prompt file path must stay under './prompts'.`,
		);
	}

	try {
		const [realPromptsRootPath, realFilePath] = await Promise.all([
			realpath(promptsRootPath),
			realpath(filePath),
		]);
		const realRelativePath = path.relative(realPromptsRootPath, realFilePath);
		if (realRelativePath.startsWith('..') || path.isAbsolute(realRelativePath)) {
			throw new Error(`prompt file path escapes '${realPromptsRootPath}'`);
		}
		return await readFile(filePath, 'utf-8');
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to load worker config ${fieldPath} from '${filePath}': ${message}`, {
			cause: error,
		});
	}
}

async function resolveInstructionInput(
	value: unknown,
	configDir: string,
	fieldPath: string,
): Promise<string | null> {
	const parsed = nullableInstructionInputSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error(
			`Invalid worker config ${fieldPath}: expected string, null, or { "path": string }.`,
			{ cause: parsed.error },
		);
	}

	const instructionInput: NullableInstructionInput = parsed.data;
	if (instructionInput === null || typeof instructionInput === 'string') {
		return instructionInput;
	}
	return await readInstructionReference(instructionInput, configDir, fieldPath);
}

async function resolveOptionalInstructionInput(
	value: unknown,
	configDir: string,
	fieldPath: string,
): Promise<string | null | undefined> {
	if (value === undefined) {
		return undefined;
	}
	return await resolveInstructionInput(value, configDir, fieldPath);
}

async function resolveInstructionField(
	record: Record<string, unknown>,
	fieldName: string,
	configDir: string,
	fieldPath: string,
): Promise<void> {
	if (!(fieldName in record)) {
		return;
	}
	record[fieldName] = await resolveInstructionInput(record[fieldName], configDir, fieldPath);
}

async function resolveOptionalInstructionField(
	record: Record<string, unknown>,
	fieldName: string,
	configDir: string,
	fieldPath: string,
): Promise<void> {
	if (!(fieldName in record)) {
		return;
	}
	record[fieldName] = await resolveOptionalInstructionInput(
		record[fieldName],
		configDir,
		fieldPath,
	);
}

function cloneRecordIfObject(value: unknown): Record<string, unknown> | undefined {
	return isObjectRecord(value) ? { ...value } : undefined;
}

export async function resolveWorkerConfigInstructionReferences(
	rawConfig: Record<string, unknown>,
	options: { readonly configPath: string },
): Promise<Record<string, unknown>> {
	const configDir = path.dirname(path.resolve(options.configPath));
	const resolvedConfig: Record<string, unknown> = { ...rawConfig };

	await resolveOptionalInstructionField(resolvedConfig, 'instructions', configDir, 'instructions');

	const phases = cloneRecordIfObject(resolvedConfig.phases);
	if (!phases) {
		return resolvedConfig;
	}

	const planPhase = cloneRecordIfObject(phases.plan);
	if (planPhase) {
		await resolveInstructionField(
			planPhase,
			'agentInstructions',
			configDir,
			'phases.plan.agentInstructions',
		);
		await resolveInstructionField(
			planPhase,
			'reviewerInstructions',
			configDir,
			'phases.plan.reviewerInstructions',
		);
		phases.plan = planPhase;
	}

	const workPhase = cloneRecordIfObject(phases.work);
	if (workPhase) {
		await resolveInstructionField(
			workPhase,
			'agentInstructions',
			configDir,
			'phases.work.agentInstructions',
		);
		await resolveInstructionField(
			workPhase,
			'reviewerInstructions',
			configDir,
			'phases.work.reviewerInstructions',
		);
		phases.work = workPhase;
	}

	const wrapupPhase = cloneRecordIfObject(phases.wrapup);
	if (wrapupPhase) {
		await resolveInstructionField(
			wrapupPhase,
			'instructions',
			configDir,
			'phases.wrapup.instructions',
		);
		phases.wrapup = wrapupPhase;
	}

	resolvedConfig.phases = phases;
	return resolvedConfig;
}

export async function loadWorkerConfig(configPath?: string): Promise<WorkerConfig> {
	if (!configPath) {
		return workerConfigSchema.parse(buildDefaultWorkerConfigInput());
	}

	try {
		const raw: unknown = JSON.parse(await readFile(configPath, 'utf-8'));
		const resolvedRaw = isObjectRecord(raw)
			? await resolveWorkerConfigInstructionReferences(raw, { configPath })
			: raw;
		return workerConfigSchema.parse(resolvedRaw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid worker config: ${message}`, { cause: error });
	}
}
