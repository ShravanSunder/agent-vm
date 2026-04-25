import fs from 'node:fs/promises';
import path from 'node:path';

import {
	DEFAULT_COMMON_AGENT_INSTRUCTIONS,
	DEFAULT_PLAN_AGENT_INSTRUCTIONS,
	DEFAULT_PLAN_REVIEWER_INSTRUCTIONS,
	DEFAULT_WORK_AGENT_INSTRUCTIONS,
	DEFAULT_WORK_REVIEWER_INSTRUCTIONS,
	DEFAULT_WRAPUP_INSTRUCTIONS,
	loadWorkerConfigDraft,
} from '@agent-vm/agent-vm-worker';

export type InstructionResetPhase = 'plan' | 'work' | 'wrapup' | 'all';

export interface ResetWorkerInstructionsOptions {
	readonly workerConfigPath: string;
	readonly phase: InstructionResetPhase;
}

export interface ResetWorkerInstructionsResult {
	readonly changed: readonly string[];
}

interface InstructionResetTarget {
	readonly defaultValue: string;
	readonly fieldName: string;
	readonly fieldPath: string;
	readonly parentPath: readonly string[];
}

const instructionResetTargets = [
	{
		defaultValue: DEFAULT_COMMON_AGENT_INSTRUCTIONS,
		fieldName: 'commonAgentInstructions',
		fieldPath: 'commonAgentInstructions',
		parentPath: [],
	},
	{
		defaultValue: DEFAULT_PLAN_AGENT_INSTRUCTIONS,
		fieldName: 'agentInstructions',
		fieldPath: 'phases.plan.agentInstructions',
		parentPath: ['phases', 'plan'],
	},
	{
		defaultValue: DEFAULT_PLAN_REVIEWER_INSTRUCTIONS,
		fieldName: 'reviewerInstructions',
		fieldPath: 'phases.plan.reviewerInstructions',
		parentPath: ['phases', 'plan'],
	},
	{
		defaultValue: DEFAULT_WORK_AGENT_INSTRUCTIONS,
		fieldName: 'agentInstructions',
		fieldPath: 'phases.work.agentInstructions',
		parentPath: ['phases', 'work'],
	},
	{
		defaultValue: DEFAULT_WORK_REVIEWER_INSTRUCTIONS,
		fieldName: 'reviewerInstructions',
		fieldPath: 'phases.work.reviewerInstructions',
		parentPath: ['phases', 'work'],
	},
	{
		defaultValue: DEFAULT_WRAPUP_INSTRUCTIONS,
		fieldName: 'instructions',
		fieldPath: 'phases.wrapup.instructions',
		parentPath: ['phases', 'wrapup'],
	},
] as const satisfies readonly InstructionResetTarget[];

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInstructionFileReference(value: unknown): value is { readonly path: string } {
	return (
		isObjectRecord(value) &&
		typeof value.path === 'string' &&
		Object.keys(value).every((key) => key === 'path')
	);
}

function selectInstructionResetTargets(
	phase: InstructionResetPhase,
): readonly InstructionResetTarget[] {
	const resetAll = phase === 'all';
	const resetPlan = resetAll || phase === 'plan';
	const resetWork = resetAll || phase === 'work';
	const resetWrapup = resetAll || phase === 'wrapup';

	return instructionResetTargets.filter((target) => {
		if (target.fieldPath === 'commonAgentInstructions') {
			return resetAll;
		}
		if (target.fieldPath.startsWith('phases.plan.')) {
			return resetPlan;
		}
		if (target.fieldPath.startsWith('phases.work.')) {
			return resetWork;
		}
		return resetWrapup;
	});
}

function getInstructionParentRecord(
	rawConfig: Record<string, unknown>,
	target: InstructionResetTarget,
): Record<string, unknown> {
	let current: Record<string, unknown> = rawConfig;
	for (const pathSegment of target.parentPath) {
		const child = current[pathSegment];
		if (!isObjectRecord(child)) {
			throw new Error(`Invalid worker config: ${target.parentPath.join('.')} must be an object.`);
		}
		current = child;
	}
	return current;
}

async function applyDefaultInstructionToRawConfig(options: {
	readonly configDir: string;
	readonly rawConfig: Record<string, unknown>;
	readonly target: InstructionResetTarget;
}): Promise<void> {
	const parentRecord = getInstructionParentRecord(options.rawConfig, options.target);
	const currentValue = parentRecord[options.target.fieldName];
	if (isInstructionFileReference(currentValue)) {
		const instructionFilePath = path.resolve(options.configDir, currentValue.path);
		await fs.writeFile(instructionFilePath, `${options.target.defaultValue}\n`, 'utf8');
		return;
	}

	parentRecord[options.target.fieldName] = options.target.defaultValue;
}

export async function resetWorkerInstructions(
	options: ResetWorkerInstructionsOptions,
): Promise<ResetWorkerInstructionsResult> {
	await loadWorkerConfigDraft(options.workerConfigPath);
	const rawConfig = JSON.parse(await fs.readFile(options.workerConfigPath, 'utf8')) as unknown;
	if (!isObjectRecord(rawConfig)) {
		throw new Error('Invalid worker config: root must be an object.');
	}

	const configDir = path.dirname(path.resolve(options.workerConfigPath));
	const targets = selectInstructionResetTargets(options.phase);
	await Promise.all(
		targets.map(async (target) => {
			await applyDefaultInstructionToRawConfig({ configDir, rawConfig, target });
		}),
	);
	await fs.writeFile(
		options.workerConfigPath,
		`${JSON.stringify(rawConfig, null, '\t')}\n`,
		'utf8',
	);
	return { changed: targets.map((target) => target.fieldPath) };
}
