import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

const SHA1_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const RELIABILITY_BINDING_NAMES = [
	'AGENT_VM_RELIABILITY_DIRTY_HASH',
	'AGENT_VM_RELIABILITY_EVIDENCE_FILE',
	'AGENT_VM_RELIABILITY_HEAD_SHA',
	'AGENT_VM_RELIABILITY_OPERATION_ID',
	'AGENT_VM_RELIABILITY_RUN_ID',
] as const;

const boundedSafeIdSchema = z.string().min(1).max(128).regex(SAFE_ID_PATTERN);
const boundedKindSchema = z.string().min(1).max(64).regex(SAFE_ID_PATTERN);
const sha256Schema = z.string().length(64).regex(SHA256_PATTERN);
const generationSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const reliabilityEvidencePayloadSchema = z
	.object({
		artifacts: z
			.array(
				z
					.object({
						operationId: boundedSafeIdSchema,
						sha256: sha256Schema,
					})
					.strict(),
			)
			.min(1)
			.max(64),
		generationIdentities: z
			.array(
				z
					.object({
						generation: generationSchema,
						targetId: boundedSafeIdSchema,
						targetKind: boundedKindSchema,
					})
					.strict(),
			)
			.min(1)
			.max(64),
		packageIdentities: z
			.array(
				z
					.object({
						checksumSha256: sha256Schema,
						name: z
							.string()
							.min(1)
							.max(128)
							.refine((value) => !value.includes('\0')),
						version: z
							.string()
							.min(1)
							.max(64)
							.refine((value) => !value.includes('\0')),
					})
					.strict(),
			)
			.min(1)
			.max(64),
		processIdentities: z
			.array(
				z
					.object({
						bootId: boundedSafeIdSchema,
						kind: boundedKindSchema,
						processId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
						startIdentity: boundedSafeIdSchema,
					})
					.strict(),
			)
			.min(1)
			.max(64),
		queryIdentities: z
			.array(
				z
					.object({
						marker: boundedSafeIdSchema,
						source: boundedSafeIdSchema,
						windowEndMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
						windowStartMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
					})
					.strict()
					.refine((identity) => identity.windowEndMs >= identity.windowStartMs),
			)
			.min(1)
			.max(64)
			.optional(),
		runtimeIdentities: z
			.array(
				z
					.object({
						generation: generationSchema,
						id: boundedSafeIdSchema,
						kind: boundedKindSchema,
					})
					.strict(),
			)
			.min(1)
			.max(64),
	})
	.strict();

export type ControlLeaseReliabilityEvidencePayload = z.infer<
	typeof reliabilityEvidencePayloadSchema
>;

export type ControlLeaseReliabilityEvidenceWriteResult =
	| { readonly kind: 'not-configured' }
	| { readonly kind: 'written'; readonly path: string };

export function expectedControlLeaseReliabilityEvidenceWriteKind(
	environment: Readonly<Record<string, string | undefined>> = process.env,
): ControlLeaseReliabilityEvidenceWriteResult['kind'] {
	return RELIABILITY_BINDING_NAMES.every((bindingName) => environment[bindingName] === undefined)
		? 'not-configured'
		: 'written';
}

interface WriteControlLeaseReliabilityEvidenceOptions {
	readonly environment?: Readonly<Record<string, string | undefined>>;
	readonly expectedOperationId: string;
	readonly payload: ControlLeaseReliabilityEvidencePayload;
}

function requireReliabilityBinding(
	environment: Readonly<Record<string, string | undefined>>,
	bindingName: (typeof RELIABILITY_BINDING_NAMES)[number],
): string {
	const bindingValue = environment[bindingName];
	if (bindingValue === undefined) {
		throw new Error(`Reliability runner binding '${bindingName}' became unavailable.`);
	}
	return bindingValue;
}

function readReliabilityBindings(
	environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<(typeof RELIABILITY_BINDING_NAMES)[number], string>> | undefined {
	const configuredBindings = RELIABILITY_BINDING_NAMES.filter(
		(bindingName) => environment[bindingName] !== undefined,
	);
	if (configuredBindings.length === 0) {
		return undefined;
	}
	if (configuredBindings.length !== RELIABILITY_BINDING_NAMES.length) {
		const missingBindings = RELIABILITY_BINDING_NAMES.filter(
			(bindingName) => environment[bindingName] === undefined,
		);
		throw new Error(
			`Reliability runner bindings are incomplete; missing ${missingBindings.join(', ')}.`,
		);
	}
	return {
		AGENT_VM_RELIABILITY_DIRTY_HASH: requireReliabilityBinding(
			environment,
			'AGENT_VM_RELIABILITY_DIRTY_HASH',
		),
		AGENT_VM_RELIABILITY_EVIDENCE_FILE: requireReliabilityBinding(
			environment,
			'AGENT_VM_RELIABILITY_EVIDENCE_FILE',
		),
		AGENT_VM_RELIABILITY_HEAD_SHA: requireReliabilityBinding(
			environment,
			'AGENT_VM_RELIABILITY_HEAD_SHA',
		),
		AGENT_VM_RELIABILITY_OPERATION_ID: requireReliabilityBinding(
			environment,
			'AGENT_VM_RELIABILITY_OPERATION_ID',
		),
		AGENT_VM_RELIABILITY_RUN_ID: requireReliabilityBinding(
			environment,
			'AGENT_VM_RELIABILITY_RUN_ID',
		),
	};
}

function validateEvidencePath(evidenceFilePath: string, operationId: string): string {
	if (
		evidenceFilePath.length === 0 ||
		Buffer.byteLength(evidenceFilePath) > 4_096 ||
		evidenceFilePath.includes('\0') ||
		!path.isAbsolute(evidenceFilePath) ||
		path.resolve(evidenceFilePath) !== evidenceFilePath ||
		path.basename(evidenceFilePath) !== `${operationId}.json`
	) {
		throw new Error('Reliability evidence path is not the canonical operation-owned JSON path.');
	}
	return evidenceFilePath;
}

export function hashControlLeaseReliabilityArtifact(serializedArtifact: string): string {
	return createHash('sha256').update(serializedArtifact, 'utf8').digest('hex');
}

export async function writeControlLeaseReliabilityEvidence(
	options: WriteControlLeaseReliabilityEvidenceOptions,
): Promise<ControlLeaseReliabilityEvidenceWriteResult> {
	const bindings = readReliabilityBindings(options.environment ?? process.env);
	if (bindings === undefined) {
		return { kind: 'not-configured' };
	}
	const expectedOperationId = boundedSafeIdSchema.parse(options.expectedOperationId);
	const operationId = boundedSafeIdSchema.parse(bindings.AGENT_VM_RELIABILITY_OPERATION_ID);
	if (operationId !== expectedOperationId) {
		throw new Error(
			`Reliability runner operation mismatch: expected '${expectedOperationId}', received '${operationId}'.`,
		);
	}
	const evidenceFilePath = validateEvidencePath(
		bindings.AGENT_VM_RELIABILITY_EVIDENCE_FILE,
		operationId,
	);
	const payload = reliabilityEvidencePayloadSchema.parse(options.payload);
	const evidence = {
		...payload,
		dirtyHash: z
			.string()
			.length(64)
			.regex(SHA256_PATTERN)
			.parse(bindings.AGENT_VM_RELIABILITY_DIRTY_HASH),
		headSha: z
			.string()
			.length(40)
			.regex(SHA1_PATTERN)
			.parse(bindings.AGENT_VM_RELIABILITY_HEAD_SHA),
		operationId,
		runId: boundedSafeIdSchema.parse(bindings.AGENT_VM_RELIABILITY_RUN_ID),
		schemaVersion: 1 as const,
	};
	await writeFile(evidenceFilePath, `${JSON.stringify(evidence, null, '\t')}\n`, {
		encoding: 'utf8',
		flag: 'wx',
		mode: 0o600,
	});
	return { kind: 'written', path: evidenceFilePath };
}
