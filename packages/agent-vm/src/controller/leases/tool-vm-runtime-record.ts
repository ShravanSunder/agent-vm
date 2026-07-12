import fs from 'node:fs/promises';
import path from 'node:path';

import { buildToolSessionLabel } from '@agent-vm/gateway-lifecycle';
import type { ManagedVm } from '@agent-vm/gondolin-adapter';
import { ZodError, z } from 'zod';

import { readProcessIdentity as defaultReadProcessIdentity } from '../../shared/managed-vm-process.js';
import { writeFileAtomically } from '../../shared/write-file-atomically.js';
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

const toolLeasesDirectoryName = 'tool-leases';

function resolveToolLeasesDirectory(stateDirectory: string): string {
	return path.join(stateDirectory, toolLeasesDirectoryName);
}

function resolveToolVmRuntimeRecordPath(stateDirectory: string, recordId: string): string {
	return path.join(resolveToolLeasesDirectory(stateDirectory), `${recordId}.json`);
}

export function toolVmRuntimeRecordFilename(record: ToolVmRuntimeRecord): string {
	return `${record.recordId}.json`;
}

function parseToolVmRuntimeRecord(rawRuntimeRecord: string): ToolVmRuntimeRecord {
	const parsedRuntimeRecord = JSON.parse(rawRuntimeRecord) as unknown;
	return toolVmRuntimeRecordSchema.parse(parsedRuntimeRecord);
}

function runtimeRecordParseError(error: SyntaxError | ZodError): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export async function loadToolVmRuntimeRecord(
	stateDirectory: string,
	recordId: string,
): Promise<ToolVmRuntimeRecord | null> {
	const runtimeRecordPath = resolveToolVmRuntimeRecordPath(stateDirectory, recordId);
	let rawRuntimeRecord: string;
	try {
		rawRuntimeRecord = await fs.readFile(runtimeRecordPath, 'utf8');
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return null;
		}
		throw error;
	}
	return parseToolVmRuntimeRecord(rawRuntimeRecord);
}

async function loadToolVmRuntimeRecordResult(
	runtimeRecordPath: string,
): Promise<ToolVmRuntimeRecordLoadResult> {
	try {
		return {
			kind: 'loaded',
			path: runtimeRecordPath,
			record: parseToolVmRuntimeRecord(await fs.readFile(runtimeRecordPath, 'utf8')),
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
	stateDirectory: string,
): Promise<ToolVmRuntimeRecordLoadResult[]> {
	const leasesDirectory = resolveToolLeasesDirectory(stateDirectory);
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
		results.push(await loadToolVmRuntimeRecordResult(runtimeRecordPath));
	}
	results.sort((left, right) => {
		const leftCreatedAt = left.kind === 'loaded' ? left.record.createdAt : '';
		const rightCreatedAt = right.kind === 'loaded' ? right.record.createdAt : '';
		return leftCreatedAt.localeCompare(rightCreatedAt) || left.path.localeCompare(right.path);
	});
	return results;
}

export async function writeToolVmRuntimeRecord(
	stateDirectory: string,
	record: ToolVmRuntimeRecord,
): Promise<void> {
	const parsedRecord = toolVmRuntimeRecordSchema.parse(record);
	const runtimeRecordPath = resolveToolVmRuntimeRecordPath(stateDirectory, parsedRecord.recordId);
	await fs.mkdir(resolveToolLeasesDirectory(stateDirectory), { recursive: true, mode: 0o700 });
	await writeFileAtomically(runtimeRecordPath, `${JSON.stringify(parsedRecord, null, 2)}\n`, {
		mode: 0o600,
	});
}

export async function deleteToolVmRuntimeRecord(
	stateDirectory: string,
	recordId: string,
): Promise<void> {
	await fs.rm(resolveToolVmRuntimeRecordPath(stateDirectory, recordId), { force: true });
}

function resolveManagedVmQemuPid(managedVm: ManagedVm): number {
	if (typeof managedVm.getHostPid !== 'function') {
		throw new Error('Managed VM wrapper is missing getHostPid(); update the Gondolin adapter.');
	}
	const qemuPid = managedVm.getHostPid();
	if (qemuPid === null) {
		throw new Error(
			'Gondolin VM runtime does not expose an active host pid; upgrade @earendil-works/gondolin to a version with VM.getHostPid().',
		);
	}
	if (!Number.isInteger(qemuPid) || qemuPid <= 0) {
		throw new Error(`Gondolin VM runtime exposed an invalid host pid: ${qemuPid}.`);
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
