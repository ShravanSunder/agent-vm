import { lstat, mkdir, readFile, readdir, rm, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

import { buildGatewaySessionLabel, type GatewayProcessSpec } from '@agent-vm/gateway-lifecycle';
import type { ManagedVm } from '@agent-vm/managed-vm';
import { ZodError, z } from 'zod';

import type { ControllerGatewayStateRoot } from '../controller/durable-state/controller-state-paths.js';
import type { ControllerWorkerTaskRuntimeRecordTarget } from '../controller/durable-state/controller-state-record-paths.js';
import {
	resolveControllerGatewayRecordTargets,
	resolveControllerWorkerTaskRuntimeRecordTarget,
} from '../controller/durable-state/controller-state-record-paths.js';
import {
	gatewayEpochIdentitySchema,
	type GatewayEpochIdentity,
} from '../controller/vm-ownership/vm-ownership-contracts.js';
import type { ManagedVmProcessTarget } from '../shared/controller-managed-vm-termination.js';
import { readProcessIdentity as defaultReadProcessIdentity } from '../shared/managed-vm-process.js';
import { writeFileAtomically } from '../shared/write-file-atomically.js';

const boundedIdentityValueSchema = z
	.string()
	.min(1)
	.max(256)
	.refine((value) => !value.includes('\0'));
const boundedAbsolutePathSchema = z
	.string()
	.min(1)
	.max(4096)
	.refine((value) => isAbsolute(value) && !value.includes('\0'));
const boundedProcessIdentityTextSchema = z
	.string()
	.min(1)
	.max(16_384)
	.refine((value) => !value.includes('\0'));
const networkPortSchema = z.number().int().min(1).max(65_535);

export const workerRuntimeRecordSchema = z
	.strictObject({
		configPath: boundedAbsolutePathSchema,
		controllerPort: networkPortSchema,
		createdAt: z.iso.datetime(),
		gateway: gatewayEpochIdentitySchema,
		guestListenPort: networkPortSchema,
		ingressPort: networkPortSchema.optional(),
		processIdentity: z.strictObject({
			command: boundedProcessIdentityTextSchema,
			lstart: boundedProcessIdentityTextSchema,
		}),
		projectNamespace: boundedIdentityValueSchema,
		qemuPid: z.number().int().positive(),
		runtimeKind: z.literal('worker-direct-process'),
		schemaVersion: z.literal(3),
		sessionLabel: boundedIdentityValueSchema,
		taskId: boundedIdentityValueSchema,
		vmId: boundedIdentityValueSchema,
		zoneId: boundedIdentityValueSchema,
	})
	.superRefine((record, context) => {
		const identityChecks = [
			{
				actual: record.gateway.gatewayVmId,
				expected: record.vmId,
				message: 'Worker Gateway epoch VM identity must match the runtime record VM identity.',
				path: ['gateway', 'gatewayVmId'],
			},
			{
				actual: record.gateway.zoneId,
				expected: record.zoneId,
				message: 'Worker Gateway epoch zone must match the runtime record zone.',
				path: ['gateway', 'zoneId'],
			},
			{
				actual: record.sessionLabel,
				expected: buildGatewaySessionLabel(record.projectNamespace, record.zoneId),
				message: 'Worker session label must match the deployment namespace and zone.',
				path: ['sessionLabel'],
			},
		] as const;
		for (const identityCheck of identityChecks) {
			if (identityCheck.actual !== identityCheck.expected) {
				context.addIssue({
					code: 'custom',
					message: identityCheck.message,
					path: [...identityCheck.path],
				});
			}
		}
	});

export type WorkerRuntimeRecord = z.infer<typeof workerRuntimeRecordSchema>;

export type WorkerRuntimeRecordLoadResult =
	| {
			readonly kind: 'loaded';
			readonly path: string;
			readonly record: WorkerRuntimeRecord;
	  }
	| {
			readonly kind: 'missing';
			readonly path: string;
	  }
	| {
			readonly error: Error;
			readonly kind: 'parse-error';
			readonly path: string;
	  };

function isMissingPathError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export async function listWorkerRuntimeRecordTargets(options: {
	readonly gatewayStateRoot: ControllerGatewayStateRoot;
}): Promise<readonly ControllerWorkerTaskRuntimeRecordTarget[]> {
	const workerTaskRecords = resolveControllerGatewayRecordTargets({
		gatewayStateRoot: options.gatewayStateRoot,
	}).workerTaskRecords;
	let collectionStatus: Awaited<ReturnType<typeof lstat>>;
	try {
		collectionStatus = await lstat(workerTaskRecords.directoryPath);
	} catch (error: unknown) {
		if (isMissingPathError(error)) {
			return Object.freeze([]);
		}
		throw error;
	}
	if (!collectionStatus.isDirectory() || collectionStatus.isSymbolicLink()) {
		throw new Error(
			`Worker runtime record collection '${workerTaskRecords.directoryPath}' must be a real directory.`,
		);
	}

	const taskEntries = (
		await readdir(workerTaskRecords.directoryPath, { withFileTypes: true })
	).toSorted((leftEntry, rightEntry) => leftEntry.name.localeCompare(rightEntry.name));
	const targets: ControllerWorkerTaskRuntimeRecordTarget[] = [];
	for (const taskEntry of taskEntries) {
		if (!taskEntry.isDirectory() || taskEntry.isSymbolicLink()) {
			throw new Error(
				`Worker runtime record task entry '${taskEntry.name}' must be a real directory.`,
			);
		}
		const target = resolveControllerWorkerTaskRuntimeRecordTarget({
			gatewayStateRoot: options.gatewayStateRoot,
			taskId: taskEntry.name,
		});
		// oxlint-disable-next-line no-await-in-loop -- every task directory must be validated before cleanup admission.
		const taskRecordEntries = await readdir(dirname(target.filePath), { withFileTypes: true });
		if (
			taskRecordEntries.length !== 1 ||
			taskRecordEntries[0]?.name !== 'gateway-runtime.json' ||
			!taskRecordEntries[0].isFile() ||
			taskRecordEntries[0].isSymbolicLink()
		) {
			throw new Error(
				`Worker runtime record task directory '${dirname(target.filePath)}' must contain only one real gateway-runtime.json file.`,
			);
		}
		targets.push(target);
	}
	return Object.freeze(targets);
}

function parseWorkerRuntimeRecord(
	rawRuntimeRecord: string,
	target: ControllerWorkerTaskRuntimeRecordTarget,
): WorkerRuntimeRecord {
	const parsedRuntimeRecord = JSON.parse(rawRuntimeRecord) as unknown;
	return parseTargetBoundWorkerRuntimeRecord(parsedRuntimeRecord, target);
}

function parseTargetBoundWorkerRuntimeRecord(
	runtimeRecord: unknown,
	target: ControllerWorkerTaskRuntimeRecordTarget,
): WorkerRuntimeRecord {
	return workerRuntimeRecordSchema
		.superRefine((record, context) => {
			if (record.zoneId !== target.zoneId) {
				context.addIssue({
					code: 'custom',
					message: 'Worker runtime record zone must match its controller target zone.',
					path: ['zoneId'],
				});
			}
			if (record.taskId !== target.taskId) {
				context.addIssue({
					code: 'custom',
					message: 'Worker runtime record task must match its controller target task.',
					path: ['taskId'],
				});
			}
		})
		.parse(runtimeRecord);
}

function normalizeRuntimeRecordParseError(error: SyntaxError | ZodError): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export async function loadWorkerRuntimeRecordResult(
	target: ControllerWorkerTaskRuntimeRecordTarget,
): Promise<WorkerRuntimeRecordLoadResult> {
	const runtimeRecordPath = target.filePath;
	try {
		return {
			kind: 'loaded',
			path: runtimeRecordPath,
			record: parseWorkerRuntimeRecord(await readFile(runtimeRecordPath, 'utf8'), target),
		};
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return { kind: 'missing', path: runtimeRecordPath };
		}
		if (!(error instanceof SyntaxError) && !(error instanceof ZodError)) {
			throw error;
		}
		return {
			error: normalizeRuntimeRecordParseError(error),
			kind: 'parse-error',
			path: runtimeRecordPath,
		};
	}
}

export async function loadWorkerRuntimeRecord(
	target: ControllerWorkerTaskRuntimeRecordTarget,
): Promise<WorkerRuntimeRecord | null> {
	const loadResult = await loadWorkerRuntimeRecordResult(target);
	if (loadResult.kind === 'missing') {
		return null;
	}
	if (loadResult.kind === 'parse-error') {
		throw loadResult.error;
	}
	return loadResult.record;
}

export async function writeWorkerRuntimeRecord(
	target: ControllerWorkerTaskRuntimeRecordTarget,
	record: WorkerRuntimeRecord,
): Promise<void> {
	const parsedRecord = parseTargetBoundWorkerRuntimeRecord(record, target);
	const runtimeRecordPath = target.filePath;
	await mkdir(dirname(runtimeRecordPath), { recursive: true });
	await writeFileAtomically(runtimeRecordPath, `${JSON.stringify(parsedRecord, null, 2)}\n`, {
		mode: 0o600,
	});
}

export async function deleteWorkerRuntimeRecord(
	target: ControllerWorkerTaskRuntimeRecordTarget,
): Promise<void> {
	await rm(target.filePath, { force: true });
	try {
		await rmdir(dirname(target.filePath));
	} catch (error: unknown) {
		if (!isMissingPathError(error)) {
			throw error;
		}
	}
}

export async function assertWorkerRuntimeRecordMatchesLiveGateway(options: {
	readonly expectedProcessTarget: ManagedVmProcessTarget;
	readonly gatewayIdentity: GatewayEpochIdentity;
	readonly managedVm: Pick<ManagedVm, 'getHostProcessId' | 'id'>;
	readonly readProcessIdentity?: typeof defaultReadProcessIdentity;
	readonly record: WorkerRuntimeRecord;
}): Promise<void> {
	const identityChecks = [
		{
			actual: options.record.vmId,
			expected: options.expectedProcessTarget.vmId,
			name: 'recorded VM identity',
		},
		{
			actual: options.managedVm.id,
			expected: options.expectedProcessTarget.vmId,
			name: 'live VM identity',
		},
		{
			actual: options.record.qemuPid,
			expected: options.expectedProcessTarget.hostPid,
			name: 'recorded host process identity',
		},
		{
			actual: options.record.processIdentity.command,
			expected: options.expectedProcessTarget.processIdentity.command,
			name: 'recorded host process command identity',
		},
		{
			actual: options.record.processIdentity.lstart,
			expected: options.expectedProcessTarget.processIdentity.lstart,
			name: 'recorded host process start identity',
		},
		{
			actual: options.record.gateway.bootId,
			expected: options.gatewayIdentity.bootId,
			name: 'boot identity',
		},
		{
			actual: options.record.gateway.controllerEpoch,
			expected: options.gatewayIdentity.controllerEpoch,
			name: 'controller epoch',
		},
		{
			actual: options.record.gateway.gatewayEpochId,
			expected: options.gatewayIdentity.gatewayEpochId,
			name: 'Gateway ownership epoch',
		},
		{
			actual: options.record.gateway.gatewayVmId,
			expected: options.gatewayIdentity.gatewayVmId,
			name: 'Gateway VM identity',
		},
		{
			actual: options.record.gateway.generationId,
			expected: options.gatewayIdentity.generationId,
			name: 'Gateway generation',
		},
		{
			actual: options.record.gateway.zoneId,
			expected: options.gatewayIdentity.zoneId,
			name: 'zone identity',
		},
	] as const;
	const liveHostProcessId = options.managedVm.getHostProcessId();
	const mismatches: string[] = identityChecks
		.filter((identityCheck) => identityCheck.actual !== identityCheck.expected)
		.map((identityCheck) => identityCheck.name);
	if (liveHostProcessId !== null && liveHostProcessId !== options.expectedProcessTarget.hostPid) {
		mismatches.push('live host process identity');
	}
	if (liveHostProcessId === options.expectedProcessTarget.hostPid) {
		const processIdentityReader = options.readProcessIdentity ?? defaultReadProcessIdentity;
		const liveProcessIdentity = await processIdentityReader(liveHostProcessId);
		if (liveProcessIdentity === null) {
			mismatches.push('live host process');
		} else {
			if (options.expectedProcessTarget.processIdentity.command !== liveProcessIdentity.command) {
				mismatches.push('live host process command identity');
			}
			if (options.expectedProcessTarget.processIdentity.lstart !== liveProcessIdentity.lstart) {
				mismatches.push('live host process start identity');
			}
		}
	}
	if (mismatches.length > 0) {
		throw new Error(
			`Worker runtime record does not match the live Worker Gateway: ${mismatches.join(', ')}.`,
		);
	}
}

function resolveManagedVmHostProcessId(
	managedVm: Pick<ManagedVm, 'getHostProcessId' | 'id'>,
): number {
	const qemuPid = managedVm.getHostProcessId();
	if (qemuPid === null) {
		throw new Error(`Managed VM '${managedVm.id}' does not expose an active host process id.`);
	}
	if (!Number.isInteger(qemuPid) || qemuPid <= 0) {
		throw new Error(`Managed VM '${managedVm.id}' exposed an invalid host process id: ${qemuPid}.`);
	}
	return qemuPid;
}

export async function buildWorkerRuntimeRecord(options: {
	readonly controllerPort: number;
	readonly gatewayIdentity: GatewayEpochIdentity;
	readonly ingressPort?: number;
	readonly managedVm: Pick<ManagedVm, 'getHostProcessId' | 'id'>;
	readonly processSpec: GatewayProcessSpec;
	readonly projectNamespace: string;
	readonly readProcessIdentity?: typeof defaultReadProcessIdentity;
	readonly systemConfigPath: string;
	readonly taskId: string;
	readonly zoneId: string;
}): Promise<WorkerRuntimeRecord> {
	const qemuPid = resolveManagedVmHostProcessId(options.managedVm);
	const processIdentityReader = options.readProcessIdentity ?? defaultReadProcessIdentity;
	const processIdentity = await processIdentityReader(qemuPid);
	if (processIdentity === null) {
		throw new Error(
			`Failed to capture process identity for Worker VM '${options.managedVm.id}' pid ${String(qemuPid)}.`,
		);
	}

	return workerRuntimeRecordSchema.parse({
		configPath: options.systemConfigPath,
		controllerPort: options.controllerPort,
		createdAt: new Date().toISOString(),
		gateway: options.gatewayIdentity,
		guestListenPort: options.processSpec.guestListenPort,
		...(options.ingressPort === undefined ? {} : { ingressPort: options.ingressPort }),
		processIdentity,
		projectNamespace: options.projectNamespace,
		qemuPid,
		runtimeKind: 'worker-direct-process',
		schemaVersion: 3,
		sessionLabel: buildGatewaySessionLabel(options.projectNamespace, options.zoneId),
		taskId: options.taskId,
		vmId: options.managedVm.id,
		zoneId: options.zoneId,
	});
}
