import { buildToolSessionLabel } from '@agent-vm/gateway-interface';

import {
	isProcessAlive,
	isManagedVmProcess,
	killOrphanedManagedVmProcess,
	killProcess,
	readProcessCommand,
	readProcessIdentity,
	sleep,
} from '../../shared/managed-vm-process.js';
import {
	readTcpListenPortOwner as defaultReadTcpListenPortOwner,
	type PortOwner,
} from '../../shared/port-owner.js';
import type { ToolVmRuntimeRecord } from './tool-vm-runtime-record.js';
import {
	deleteToolVmRuntimeRecord,
	loadAllToolVmRuntimeRecords,
} from './tool-vm-runtime-record.js';

function writeRecoveryLog(message: string): void {
	process.stderr.write(`[agent-vm] ${message}\n`);
}

// All five fences are required — there is no legacy/fallback path for tool
// VMs because this format ships in the same release as the cleanup. Any
// caller (Phase A or offline) must supply expectedConfigPath +
// expectedControllerPort alongside the in-deployment projectNamespace /
// zoneId. The fifth fence (sessionLabel) is recomputed from per-record
// projectNamespace + zoneId + tcpSlot and must match what the record stored.
function validateToolVmRecordCleanupScope(options: {
	readonly expectedConfigPath: string;
	readonly expectedControllerPort: number;
	readonly projectNamespace: string;
	readonly runtimeRecord: ToolVmRuntimeRecord;
	readonly stateDir: string;
	readonly zoneId: string;
}): string | null {
	if (options.runtimeRecord.configPath !== options.expectedConfigPath) {
		return `Tool VM runtime record for lease '${options.runtimeRecord.leaseId}' at '${options.stateDir}' belongs to configPath '${options.runtimeRecord.configPath}', not '${options.expectedConfigPath}'. Refusing scoped cleanup.`;
	}
	if (options.runtimeRecord.controllerPort !== options.expectedControllerPort) {
		return `Tool VM runtime record for lease '${options.runtimeRecord.leaseId}' at '${options.stateDir}' belongs to controllerPort '${options.runtimeRecord.controllerPort}', not '${options.expectedControllerPort}'. Refusing scoped cleanup.`;
	}
	if (options.runtimeRecord.projectNamespace !== options.projectNamespace) {
		return `Tool VM runtime record for lease '${options.runtimeRecord.leaseId}' at '${options.stateDir}' belongs to projectNamespace '${options.runtimeRecord.projectNamespace}', not '${options.projectNamespace}'. Refusing scoped cleanup.`;
	}
	if (options.runtimeRecord.zoneId !== options.zoneId) {
		return `Tool VM runtime record for lease '${options.runtimeRecord.leaseId}' at '${options.stateDir}' belongs to zone '${options.runtimeRecord.zoneId}', not requested zone '${options.zoneId}'. Refusing scoped cleanup.`;
	}
	const expectedSessionLabel = buildToolSessionLabel(
		options.projectNamespace,
		options.zoneId,
		options.runtimeRecord.tcpSlot,
	);
	if (options.runtimeRecord.sessionLabel !== expectedSessionLabel) {
		return `Tool VM runtime record for lease '${options.runtimeRecord.leaseId}' at '${options.stateDir}' session label '${options.runtimeRecord.sessionLabel}' does not match expected '${expectedSessionLabel}'. Refusing scoped cleanup.`;
	}
	return null;
}

async function killOrphanedToolVmProcess(
	runtimeRecord: ToolVmRuntimeRecord,
	dependencies: Required<
		Pick<
			ToolVmRecoveryDependencies,
			'isProcessAlive' | 'killProcess' | 'readProcessCommand' | 'readProcessIdentity' | 'sleep'
		>
	>,
): Promise<number | null> {
	return await killOrphanedManagedVmProcess({
		contextLabel: `Tool VM runtime record for lease '${runtimeRecord.leaseId}' (zone '${runtimeRecord.zoneId}', slot ${runtimeRecord.tcpSlot})`,
		dependencies,
		pid: runtimeRecord.qemuPid,
		recordedIdentity: runtimeRecord.processIdentity,
	});
}

type ToolVmPortOwnershipProof =
	| { readonly kind: 'owned' }
	| { readonly kind: 'record-stale' }
	| { readonly kind: 'unproven'; readonly warning: string };

interface ProvenToolVmRuntimeRecord {
	readonly portOwnershipProof: ToolVmPortOwnershipProof;
	readonly runtimeRecord: ToolVmRuntimeRecord;
}

interface ToolVmRecordCleanupOutcome {
	readonly cleanedCount: number;
	readonly killedPids: readonly number[];
	readonly warnings: readonly string[];
}

async function verifyToolVmPortOwnership(options: {
	readonly portForSlot?: (slot: number) => number;
	readonly readTcpListenPortOwner?: (port: number) => Promise<PortOwner | null>;
	readonly runtimeRecord: ToolVmRuntimeRecord;
}): Promise<ToolVmPortOwnershipProof> {
	if (!options.portForSlot && !options.readTcpListenPortOwner) {
		return { kind: 'owned' };
	}
	if (!options.portForSlot) {
		return {
			kind: 'unproven',
			warning: `Tool VM runtime record '${options.runtimeRecord.recordId}' cannot verify port ownership because no portForSlot dependency was provided.`,
		};
	}
	const readTcpListenPortOwner = options.readTcpListenPortOwner ?? defaultReadTcpListenPortOwner;
	const expectedPort = options.portForSlot(options.runtimeRecord.tcpSlot);
	const portOwner = await readTcpListenPortOwner(expectedPort);
	if (portOwner === null) {
		return { kind: 'record-stale' };
	}
	if (portOwner.pid !== options.runtimeRecord.qemuPid) {
		return {
			kind: 'unproven',
			warning: `Tool VM runtime record '${options.runtimeRecord.recordId}' port ${String(expectedPort)} is held by pid ${String(portOwner.pid)}, expected pid ${String(options.runtimeRecord.qemuPid)}.`,
		};
	}
	if (!isManagedVmProcess(portOwner.command)) {
		return {
			kind: 'unproven',
			warning: `Tool VM runtime record '${options.runtimeRecord.recordId}' port ${String(expectedPort)} is held by pid ${String(portOwner.pid)} but command is not a managed VM process: ${portOwner.command}.`,
		};
	}
	return { kind: 'owned' };
}

export interface ToolVmRecoveryDependencies {
	readonly deleteToolVmRuntimeRecord?: typeof deleteToolVmRuntimeRecord;
	readonly isProcessAlive?: (pid: number) => boolean;
	readonly killProcess?: (pid: number, signal: NodeJS.Signals) => void;
	readonly loadAllToolVmRuntimeRecords?: typeof loadAllToolVmRuntimeRecords;
	readonly log?: (message: string) => void;
	readonly portForSlot?: (slot: number) => number;
	readonly readProcessCommand?: (pid: number) => Promise<string | null>;
	readonly readProcessIdentity?: typeof readProcessIdentity;
	readonly readTcpListenPortOwner?: (port: number) => Promise<PortOwner | null>;
	readonly sleep?: (delayMs: number) => Promise<void>;
}

export interface ToolVmCleanupResult {
	readonly cleanedCount: number;
	readonly killedPids: readonly number[];
	readonly quarantinedCount: number;
	readonly warnings: readonly string[];
}

export async function cleanupOrphanedToolVmsIfPresent(
	options: {
		readonly expectedConfigPath: string;
		readonly expectedControllerPort: number;
		readonly mode?: 'in-process-recovery' | 'offline-cleanup';
		readonly projectNamespace: string;
		readonly stateDir: string;
		readonly tcpBasePort?: number;
		readonly zoneId: string;
	},
	dependencies: ToolVmRecoveryDependencies = {},
): Promise<ToolVmCleanupResult> {
	const log = dependencies.log ?? writeRecoveryLog;
	const runtimeRecordResults = await (
		dependencies.loadAllToolVmRuntimeRecords ?? loadAllToolVmRuntimeRecords
	)(options.stateDir);
	if (runtimeRecordResults.length === 0) {
		return { cleanedCount: 0, killedPids: [], quarantinedCount: 0, warnings: [] };
	}

	const killedPids: number[] = [];
	const warnings: string[] = [];
	let cleanedCount = 0;
	const killDependencies = {
		isProcessAlive: dependencies.isProcessAlive ?? isProcessAlive,
		killProcess: dependencies.killProcess ?? killProcess,
		readProcessCommand: dependencies.readProcessCommand ?? readProcessCommand,
		readProcessIdentity: dependencies.readProcessIdentity ?? readProcessIdentity,
		sleep: dependencies.sleep ?? sleep,
	};
	const deleteRecord = dependencies.deleteToolVmRuntimeRecord ?? deleteToolVmRuntimeRecord;
	const portForSlot =
		dependencies.portForSlot ??
		(options.tcpBasePort === undefined
			? undefined
			: (
					(tcpBasePort: number) =>
					(slot: number): number =>
						tcpBasePort + slot
				)(options.tcpBasePort));

	const validRuntimeRecords: ToolVmRuntimeRecord[] = [];
	for (const runtimeRecordResult of runtimeRecordResults) {
		if (runtimeRecordResult.kind === 'parse-error') {
			const warning = `Tool VM runtime record at '${runtimeRecordResult.path}' failed to parse: ${runtimeRecordResult.error.message}. Skipping during in-process recovery without mutating the file.`;
			if (options.mode !== 'in-process-recovery') {
				throw new Error(warning);
			}
			log(warning);
			warnings.push(warning);
			continue;
		}
		const runtimeRecord = runtimeRecordResult.record;
		const scopeMismatch = validateToolVmRecordCleanupScope({
			expectedConfigPath: options.expectedConfigPath,
			expectedControllerPort: options.expectedControllerPort,
			projectNamespace: options.projectNamespace,
			runtimeRecord,
			stateDir: options.stateDir,
			zoneId: options.zoneId,
		});
		if (scopeMismatch !== null) {
			if (options.mode !== 'in-process-recovery') {
				throw new Error(scopeMismatch);
			}
			const warning = `${scopeMismatch} Skipping the stale runtime record without signaling its recorded process during in-process recovery.`;
			log(warning);
			warnings.push(warning);
			continue;
		}

		log(
			`Found persisted tool VM runtime for lease '${runtimeRecord.leaseId}' (zone '${runtimeRecord.zoneId}', slot ${runtimeRecord.tcpSlot}, pid ${runtimeRecord.qemuPid}, vm ${runtimeRecord.vmId}).`,
		);
		validRuntimeRecords.push(runtimeRecord);
	}

	const provenRuntimeRecords: readonly ProvenToolVmRuntimeRecord[] = await Promise.all(
		validRuntimeRecords.map(async (runtimeRecord) => ({
			portOwnershipProof: await verifyToolVmPortOwnership({
				...(portForSlot ? { portForSlot } : {}),
				...(dependencies.readTcpListenPortOwner
					? { readTcpListenPortOwner: dependencies.readTcpListenPortOwner }
					: {}),
				runtimeRecord,
			}),
			runtimeRecord,
		})),
	);

	const cleanupReadyRuntimeRecords: ProvenToolVmRuntimeRecord[] = [];
	for (const provenRuntimeRecord of provenRuntimeRecords) {
		const { portOwnershipProof } = provenRuntimeRecord;
		if (portOwnershipProof.kind === 'unproven') {
			if (options.mode !== 'in-process-recovery') {
				throw new Error(portOwnershipProof.warning);
			}
			const warning = `Skipping ${portOwnershipProof.warning}`;
			log(warning);
			warnings.push(warning);
			continue;
		}
		cleanupReadyRuntimeRecords.push(provenRuntimeRecord);
	}

	const cleanupOutcomes = await Promise.all(
		cleanupReadyRuntimeRecords.map(async ({ runtimeRecord }) => {
			const killedPid = await killOrphanedToolVmProcess(runtimeRecord, killDependencies);
			try {
				await deleteRecord(options.stateDir, runtimeRecord.recordId);
			} catch (error) {
				const warning = `Failed to remove stale tool VM runtime record for lease '${runtimeRecord.leaseId}' at '${options.stateDir}': ${error instanceof Error ? error.message : JSON.stringify(error)}`;
				log(warning);
				return {
					cleanedCount: 0,
					killedPids: killedPid === null ? [] : [killedPid],
					warnings: [warning],
				} satisfies ToolVmRecordCleanupOutcome;
			}
			log(
				killedPid === null
					? `Removed stale tool VM runtime record for lease '${runtimeRecord.leaseId}' after confirming the orphaned process was already gone.`
					: `Removed stale tool VM runtime record for lease '${runtimeRecord.leaseId}' after terminating orphaned tool VM pid ${killedPid}.`,
			);
			return {
				cleanedCount: 1,
				killedPids: killedPid === null ? [] : [killedPid],
				warnings: [],
			} satisfies ToolVmRecordCleanupOutcome;
		}),
	);
	for (const cleanupOutcome of cleanupOutcomes) {
		cleanedCount += cleanupOutcome.cleanedCount;
		killedPids.push(...cleanupOutcome.killedPids);
		warnings.push(...cleanupOutcome.warnings);
	}

	return { cleanedCount, killedPids, quarantinedCount: 0, warnings };
}
