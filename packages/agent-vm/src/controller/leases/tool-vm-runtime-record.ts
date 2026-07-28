import fs from 'node:fs/promises';
import path from 'node:path';

import { buildToolSessionLabel } from '@agent-vm/gateway-lifecycle';
import type { ManagedVm } from '@agent-vm/managed-vm';
import { ZodError, z } from 'zod';

import { readProcessIdentity as defaultReadProcessIdentity } from '../../shared/managed-vm-process.js';
import { writeFileAtomically } from '../../shared/write-file-atomically.js';
import type { ControllerToolLeaseRecordsTarget } from '../durable-state/controller-state-record-paths.js';
import {
	gatewayEpochIdentitySchema,
	type GatewayEpochIdentity,
} from '../vm-ownership/vm-ownership-contracts.js';

export const toolVmRuntimeRecordSchema = z
	.strictObject({
		schemaVersion: z.literal(2),
		recordId: z.uuid(),
		agentId: z.string().min(1),
		leaseId: z.string().min(1),
		vmId: z.string().min(1),
		qemuPid: z.number().int().positive(),
		processIdentity: z.strictObject({
			command: z.string().min(1),
			lstart: z.string().min(1),
		}),
		configPath: z.string().min(1),
		controllerPort: z.number().int().positive(),
		projectNamespace: z.string().min(1),
		zoneId: z.string().min(1),
		gateway: gatewayEpochIdentitySchema,
		tcpSlot: z.number().int().nonnegative(),
		sessionLabel: z.string().min(1),
		createdAt: z.iso.datetime(),
	})
	.superRefine((record, context) => {
		if (record.gateway.zoneId !== record.zoneId) {
			context.addIssue({
				code: 'custom',
				message: 'Parent Gateway epoch zone must match the Tool VM runtime record zone.',
				path: ['gateway', 'zoneId'],
			});
		}
	});

export type ToolVmRuntimeRecord = z.infer<typeof toolVmRuntimeRecordSchema>;
export type ToolVmRuntimeLog = (message: string) => void;

export type ToolVmRuntimeRecordLoadResult =
	| {
			readonly kind: 'loaded';
			readonly path: string;
			readonly record: ToolVmRuntimeRecord;
	  }
	| {
			readonly error: Error;
			readonly kind: 'parse-error';
			readonly path: string;
	  };

const toolVmRuntimeRecordIdSchema = z.uuid();

function toolVmRuntimeRecordSchemaForTarget(
	recordsTarget: ControllerToolLeaseRecordsTarget,
): z.ZodType<ToolVmRuntimeRecord> {
	return toolVmRuntimeRecordSchema.superRefine((record, context) => {
		if (record.zoneId !== recordsTarget.zoneId) {
			context.addIssue({
				code: 'custom',
				message: `Tool VM runtime record zone '${record.zoneId}' does not match target zone '${recordsTarget.zoneId}'.`,
				path: ['zoneId'],
			});
		}
	});
}

function resolveToolVmRuntimeRecordPath(
	recordsTarget: ControllerToolLeaseRecordsTarget,
	recordId: string,
): string {
	return path.join(
		recordsTarget.directoryPath,
		`${toolVmRuntimeRecordIdSchema.parse(recordId)}.json`,
	);
}

export function toolVmRuntimeRecordFilename(record: ToolVmRuntimeRecord): string {
	return `${record.recordId}.json`;
}

function parseToolVmRuntimeRecord(
	rawRuntimeRecord: string,
	recordsTarget: ControllerToolLeaseRecordsTarget,
): ToolVmRuntimeRecord {
	const parsedRuntimeRecord = JSON.parse(rawRuntimeRecord) as unknown;
	return toolVmRuntimeRecordSchemaForTarget(recordsTarget).parse(parsedRuntimeRecord);
}

function runtimeRecordParseError(error: SyntaxError | ZodError): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export async function loadToolVmRuntimeRecord(
	recordsTarget: ControllerToolLeaseRecordsTarget,
	recordId: string,
): Promise<ToolVmRuntimeRecord | null> {
	const runtimeRecordPath = resolveToolVmRuntimeRecordPath(recordsTarget, recordId);
	let rawRuntimeRecord: string;
	try {
		rawRuntimeRecord = await fs.readFile(runtimeRecordPath, 'utf8');
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return null;
		}
		throw error;
	}
	return parseToolVmRuntimeRecord(rawRuntimeRecord, recordsTarget);
}

async function loadToolVmRuntimeRecordResult(
	runtimeRecordPath: string,
	recordsTarget: ControllerToolLeaseRecordsTarget,
): Promise<ToolVmRuntimeRecordLoadResult> {
	try {
		return {
			kind: 'loaded',
			path: runtimeRecordPath,
			record: parseToolVmRuntimeRecord(await fs.readFile(runtimeRecordPath, 'utf8'), recordsTarget),
		};
	} catch (error) {
		if (!(error instanceof SyntaxError) && !(error instanceof ZodError)) {
			throw error;
		}
		return {
			error: runtimeRecordParseError(error),
			kind: 'parse-error',
			path: runtimeRecordPath,
		};
	}
}

export async function loadAllToolVmRuntimeRecords(
	recordsTarget: ControllerToolLeaseRecordsTarget,
): Promise<ToolVmRuntimeRecordLoadResult[]> {
	const leasesDirectory = recordsTarget.directoryPath;
	let entries: string[];
	try {
		entries = await fs.readdir(leasesDirectory);
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return [];
		}
		throw error;
	}
	const results: ToolVmRuntimeRecordLoadResult[] = [];
	for (const entry of entries) {
		if (!entry.endsWith('.json')) {
			continue;
		}
		const runtimeRecordPath = path.join(leasesDirectory, entry);
		// oxlint-disable-next-line no-await-in-loop -- per-entry parse errors need their own path.
		results.push(await loadToolVmRuntimeRecordResult(runtimeRecordPath, recordsTarget));
	}
	results.sort((left, right) => {
		const leftCreatedAt = left.kind === 'loaded' ? left.record.createdAt : '';
		const rightCreatedAt = right.kind === 'loaded' ? right.record.createdAt : '';
		return leftCreatedAt.localeCompare(rightCreatedAt) || left.path.localeCompare(right.path);
	});
	return results;
}

export async function writeToolVmRuntimeRecord(
	recordsTarget: ControllerToolLeaseRecordsTarget,
	record: ToolVmRuntimeRecord,
): Promise<void> {
	const parsedRecord = toolVmRuntimeRecordSchemaForTarget(recordsTarget).parse(record);
	const runtimeRecordPath = resolveToolVmRuntimeRecordPath(recordsTarget, parsedRecord.recordId);
	await fs.mkdir(recordsTarget.directoryPath, { recursive: true, mode: 0o700 });
	await writeFileAtomically(runtimeRecordPath, `${JSON.stringify(parsedRecord, null, 2)}\n`, {
		mode: 0o600,
	});
}

export async function deleteToolVmRuntimeRecord(
	recordsTarget: ControllerToolLeaseRecordsTarget,
	recordId: string,
): Promise<void> {
	await fs.rm(resolveToolVmRuntimeRecordPath(recordsTarget, recordId), { force: true });
}

function resolveManagedVmQemuPid(managedVm: ManagedVm): number {
	const qemuPid = managedVm.getHostProcessId();
	if (qemuPid === null) {
		throw new Error('Managed VM does not expose an active host process id after start.');
	}
	if (!Number.isInteger(qemuPid) || qemuPid <= 0) {
		throw new Error(`Managed VM exposed an invalid host process id: ${qemuPid}.`);
	}

	return qemuPid;
}

export async function buildToolVmRuntimeRecord(options: {
	readonly agentId: string;
	readonly controllerPort: number;
	readonly gatewayIdentity: GatewayEpochIdentity;
	readonly leaseId: string;
	readonly managedVm: ManagedVm;
	readonly projectNamespace: string;
	readonly readProcessIdentity?: typeof defaultReadProcessIdentity;
	readonly recordId: string;
	readonly systemConfigPath: string;
	readonly tcpSlot: number;
	readonly zoneId: string;
}): Promise<ToolVmRuntimeRecord> {
	const qemuPid = resolveManagedVmQemuPid(options.managedVm);
	const processIdentityReader = options.readProcessIdentity ?? defaultReadProcessIdentity;
	const processIdentity = await processIdentityReader(qemuPid);
	if (processIdentity === null) {
		throw new Error(
			`Failed to capture process identity for Tool VM '${options.managedVm.id}' pid ${String(qemuPid)}.`,
		);
	}
	return toolVmRuntimeRecordSchema.parse({
		agentId: options.agentId,
		configPath: options.systemConfigPath,
		controllerPort: options.controllerPort,
		createdAt: new Date().toISOString(),
		gateway: options.gatewayIdentity,
		leaseId: options.leaseId,
		processIdentity,
		projectNamespace: options.projectNamespace,
		qemuPid,
		recordId: options.recordId,
		schemaVersion: 2,
		sessionLabel: buildToolSessionLabel(options.projectNamespace, options.zoneId, options.tcpSlot),
		tcpSlot: options.tcpSlot,
		vmId: options.managedVm.id,
		zoneId: options.zoneId,
	});
}
