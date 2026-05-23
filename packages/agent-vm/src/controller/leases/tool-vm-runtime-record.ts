import fs from 'node:fs/promises';
import path from 'node:path';

import { buildToolSessionLabel } from '@agent-vm/gateway-interface';
import { type ManagedVm, writeFileAtomically } from '@agent-vm/gondolin-adapter';
import { ZodError, z } from 'zod';

import { readProcessIdentity as defaultReadProcessIdentity } from '../../shared/managed-vm-process.js';

// Tool VM runtime record — added in this PR; no prior on-disk format exists.
// `schemaVersion` is the explicit version anchor for future migrations:
// if a future field becomes required, the load path will dispatch on
// schemaVersion rather than silently quarantining and orphaning the QEMU.
export const toolVmRuntimeRecordSchema = z.object({
	configPath: z.string().min(1),
	controllerPort: z.number().int().positive(),
	createdAt: z.iso.datetime(),
	leaseId: z.string().min(1),
	processIdentity: z.object({
		command: z.string().min(1),
		lstart: z.string().min(1),
	}),
	projectNamespace: z.string().min(1),
	qemuPid: z.number().int().positive(),
	schemaVersion: z.literal(1),
	scopeKey: z.string().min(1),
	sessionLabel: z.string().min(1),
	tcpSlot: z.number().int().nonnegative(),
	vmId: z.string().min(1),
	zoneId: z.string().min(1),
});

export type ToolVmRuntimeRecord = z.infer<typeof toolVmRuntimeRecordSchema>;
export type ToolVmRuntimeLog = (message: string) => void;

const toolLeasesDirectoryName = 'tool-leases';
const quarantinedFilePattern = /^(?<leaseId>.+)\.quarantined\.\d+\.json$/u;
// Defense-in-depth guardrail: the request-schema layer narrows scopeKey to a
// strict regex, but lease.id strings flow through several layers before they
// reach disk. We refuse any leaseId that contains a path-meaningful character
// at the filesystem boundary so a future regression elsewhere cannot escape
// the tool-leases/ subtree.
const pathSafeLeaseIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/u;

function assertPathSafeLeaseId(leaseId: string): void {
	if (!pathSafeLeaseIdPattern.test(leaseId) || leaseId.includes('..')) {
		throw new Error(
			`Refusing to derive a runtime-record path from unsafe leaseId '${leaseId}': contains path-meaningful characters.`,
		);
	}
}

function resolveToolLeasesDirectory(stateDirectory: string): string {
	return path.join(stateDirectory, toolLeasesDirectoryName);
}

function resolveToolVmRuntimeRecordPath(stateDirectory: string, leaseId: string): string {
	assertPathSafeLeaseId(leaseId);
	return path.join(resolveToolLeasesDirectory(stateDirectory), `${leaseId}.json`);
}

function resolveInvalidToolVmRuntimeRecordPath(stateDirectory: string, leaseId: string): string {
	assertPathSafeLeaseId(leaseId);
	return path.join(
		resolveToolLeasesDirectory(stateDirectory),
		`${leaseId}.invalid.${Date.now()}.json`,
	);
}

function resolveQuarantinedToolVmRuntimeRecordPath(
	stateDirectory: string,
	leaseId: string,
): string {
	assertPathSafeLeaseId(leaseId);
	return path.join(
		resolveToolLeasesDirectory(stateDirectory),
		`${leaseId}.quarantined.${Date.now()}.json`,
	);
}

function writeToolVmRuntimeLog(message: string): void {
	process.stderr.write(`[agent-vm] ${message}\n`);
}

async function quarantineMalformedToolVmRuntimeRecord(
	stateDirectory: string,
	leaseId: string,
	runtimeRecordPath: string,
	log: ToolVmRuntimeLog,
): Promise<void> {
	const invalidRuntimeRecordPath = resolveInvalidToolVmRuntimeRecordPath(stateDirectory, leaseId);
	try {
		await fs.rename(runtimeRecordPath, invalidRuntimeRecordPath);
		log(
			`Quarantined malformed tool VM runtime record '${runtimeRecordPath}' to '${invalidRuntimeRecordPath}'.`,
		);
		return;
	} catch (error) {
		await fs.rm(runtimeRecordPath, { force: true });
		log(
			`Deleted malformed tool VM runtime record '${runtimeRecordPath}' after quarantine rename failed: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
		);
	}
}

export async function quarantineToolVmRuntimeRecord(
	stateDirectory: string,
	leaseId: string,
	options: {
		readonly log?: ToolVmRuntimeLog;
		readonly reason: string;
	} = { reason: 'runtime record no longer matches the active cleanup scope' },
): Promise<void> {
	const runtimeRecordPath = resolveToolVmRuntimeRecordPath(stateDirectory, leaseId);
	const quarantinedRuntimeRecordPath = resolveQuarantinedToolVmRuntimeRecordPath(
		stateDirectory,
		leaseId,
	);
	try {
		await fs.rename(runtimeRecordPath, quarantinedRuntimeRecordPath);
		(options.log ?? writeToolVmRuntimeLog)(
			`Quarantined tool VM runtime record '${runtimeRecordPath}' to '${quarantinedRuntimeRecordPath}': ${options.reason}.`,
		);
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return;
		}
		throw error;
	}
}

export async function loadToolVmRuntimeRecord(
	stateDirectory: string,
	leaseId: string,
	options: {
		readonly log?: ToolVmRuntimeLog;
	} = {},
): Promise<ToolVmRuntimeRecord | null> {
	const runtimeRecordPath = resolveToolVmRuntimeRecordPath(stateDirectory, leaseId);
	let rawRuntimeRecord: string;
	try {
		rawRuntimeRecord = await fs.readFile(runtimeRecordPath, 'utf8');
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return null;
		}
		throw error;
	}

	try {
		const parsedRuntimeRecord = JSON.parse(rawRuntimeRecord) as unknown;
		return toolVmRuntimeRecordSchema.parse(parsedRuntimeRecord);
	} catch (error) {
		if (!(error instanceof SyntaxError) && !(error instanceof ZodError)) {
			throw error;
		}
		await quarantineMalformedToolVmRuntimeRecord(
			stateDirectory,
			leaseId,
			runtimeRecordPath,
			options.log ?? writeToolVmRuntimeLog,
		);
		return null;
	}
}

export async function loadAllToolVmRuntimeRecords(
	stateDirectory: string,
	options: {
		readonly log?: ToolVmRuntimeLog;
	} = {},
): Promise<ToolVmRuntimeRecord[]> {
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
	const records: ToolVmRuntimeRecord[] = [];
	for (const entry of entries) {
		// Skip quarantined files and anything that doesn't look like a runtime
		// record. The `*.invalid.<ts>.json` and `*.quarantined.<ts>.json` files
		// produced by quarantine paths must NOT be re-loaded.
		if (quarantinedFilePattern.test(entry) || entry.includes('.invalid.')) {
			continue;
		}
		if (!entry.endsWith('.json')) {
			continue;
		}
		const leaseId = entry.slice(0, -'.json'.length);
		if (leaseId.length === 0) {
			continue;
		}
		// oxlint-disable-next-line no-await-in-loop -- per-entry load needs to surface its own quarantine state
		const record = await loadToolVmRuntimeRecord(stateDirectory, leaseId, options);
		if (record !== null) {
			records.push(record);
		}
	}
	// Sort by createdAt for deterministic iteration order in tests + logs.
	records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
	return records;
}

export async function writeToolVmRuntimeRecord(
	stateDirectory: string,
	record: ToolVmRuntimeRecord,
): Promise<void> {
	const runtimeRecordPath = resolveToolVmRuntimeRecordPath(stateDirectory, record.leaseId);
	await fs.mkdir(resolveToolLeasesDirectory(stateDirectory), { recursive: true, mode: 0o700 });
	await writeFileAtomically(
		runtimeRecordPath,
		`${JSON.stringify(toolVmRuntimeRecordSchema.parse(record), null, 2)}\n`,
		{ mode: 0o600 },
	);
}

export async function deleteToolVmRuntimeRecord(
	stateDirectory: string,
	leaseId: string,
): Promise<void> {
	await fs.rm(resolveToolVmRuntimeRecordPath(stateDirectory, leaseId), { force: true });
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
	readonly controllerPort: number;
	readonly leaseId: string;
	readonly managedVm: ManagedVm;
	readonly projectNamespace: string;
	readonly readProcessIdentity?: typeof defaultReadProcessIdentity;
	readonly scopeKey: string;
	readonly systemConfigPath: string;
	readonly tcpSlot: number;
	readonly zoneId: string;
}): Promise<ToolVmRuntimeRecord> {
	const qemuPid = resolveManagedVmQemuPid(options.managedVm);
	// Capture process identity (ps lstart + command) for PID-reuse defense
	// on recovery. If ps fails or the process vanished between getHostPid and
	// the ps call, the record is unwritable — surface clearly rather than
	// silently dropping the identity check.
	const identity = await (options.readProcessIdentity ?? defaultReadProcessIdentity)(qemuPid);
	if (identity === null) {
		throw new Error(
			`Failed to capture process identity for managed VM pid ${qemuPid}: ps returned no rows. The VM may have exited during lease creation.`,
		);
	}
	return {
		configPath: options.systemConfigPath,
		controllerPort: options.controllerPort,
		createdAt: new Date().toISOString(),
		leaseId: options.leaseId,
		processIdentity: identity,
		projectNamespace: options.projectNamespace,
		qemuPid,
		schemaVersion: 1,
		scopeKey: options.scopeKey,
		sessionLabel: buildToolSessionLabel(options.projectNamespace, options.zoneId, options.tcpSlot),
		tcpSlot: options.tcpSlot,
		vmId: options.managedVm.id,
		zoneId: options.zoneId,
	};
}
