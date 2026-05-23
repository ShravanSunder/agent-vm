import { buildToolSessionLabel } from '@agent-vm/gateway-interface';

import {
	isProcessAlive,
	killOrphanedManagedVmProcess,
	killProcess,
	readProcessCommand,
	readProcessIdentity,
	sleep,
} from '../../shared/managed-vm-process.js';
import type { ToolVmRuntimeRecord } from './tool-vm-runtime-record.js';
import {
	deleteToolVmRuntimeRecord,
	loadAllToolVmRuntimeRecords,
	quarantineToolVmRuntimeRecord,
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

export interface ToolVmRecoveryDependencies {
	readonly deleteToolVmRuntimeRecord?: typeof deleteToolVmRuntimeRecord;
	readonly isProcessAlive?: (pid: number) => boolean;
	readonly killProcess?: (pid: number, signal: NodeJS.Signals) => void;
	readonly loadAllToolVmRuntimeRecords?: typeof loadAllToolVmRuntimeRecords;
	readonly log?: (message: string) => void;
	readonly quarantineToolVmRuntimeRecord?: typeof quarantineToolVmRuntimeRecord;
	readonly readProcessCommand?: (pid: number) => Promise<string | null>;
	readonly readProcessIdentity?: typeof readProcessIdentity;
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
		readonly zoneId: string;
	},
	dependencies: ToolVmRecoveryDependencies = {},
): Promise<ToolVmCleanupResult> {
	const log = dependencies.log ?? writeRecoveryLog;
	const runtimeRecords = await (
		dependencies.loadAllToolVmRuntimeRecords ?? loadAllToolVmRuntimeRecords
	)(options.stateDir, { log });
	if (runtimeRecords.length === 0) {
		return { cleanedCount: 0, killedPids: [], quarantinedCount: 0, warnings: [] };
	}

	const killedPids: number[] = [];
	const warnings: string[] = [];
	let cleanedCount = 0;
	let quarantinedCount = 0;
	const killDependencies = {
		isProcessAlive: dependencies.isProcessAlive ?? isProcessAlive,
		killProcess: dependencies.killProcess ?? killProcess,
		readProcessCommand: dependencies.readProcessCommand ?? readProcessCommand,
		readProcessIdentity: dependencies.readProcessIdentity ?? readProcessIdentity,
		sleep: dependencies.sleep ?? sleep,
	};
	const quarantine = dependencies.quarantineToolVmRuntimeRecord ?? quarantineToolVmRuntimeRecord;
	const deleteRecord = dependencies.deleteToolVmRuntimeRecord ?? deleteToolVmRuntimeRecord;

	for (const runtimeRecord of runtimeRecords) {
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
			const warning = `${scopeMismatch} Quarantining the stale runtime record without signaling its recorded process during in-process recovery.`;
			log(warning);
			try {
				// oxlint-disable-next-line no-await-in-loop -- quarantine each record before moving on; failures are isolated
				await quarantine(options.stateDir, runtimeRecord.leaseId, {
					log,
					reason: warning,
				});
				warnings.push(warning);
				quarantinedCount += 1;
			} catch (quarantineError) {
				// Quarantine failure must not abort the cleanup loop; the remaining
				// records may still match scope and need their PIDs reaped. Log
				// and surface as a warning so the operator can investigate.
				const quarantineWarning = `Failed to quarantine stale tool VM runtime record for lease '${runtimeRecord.leaseId}' at '${options.stateDir}': ${quarantineError instanceof Error ? quarantineError.message : JSON.stringify(quarantineError)}`;
				log(quarantineWarning);
				warnings.push(quarantineWarning);
			}
			continue;
		}

		log(
			`Found persisted tool VM runtime for lease '${runtimeRecord.leaseId}' (zone '${runtimeRecord.zoneId}', slot ${runtimeRecord.tcpSlot}, pid ${runtimeRecord.qemuPid}, vm ${runtimeRecord.vmId}).`,
		);

		// oxlint-disable-next-line no-await-in-loop -- per-record cleanup is intentionally serial to bound concurrent signals to QEMU pids
		const killedPid = await killOrphanedToolVmProcess(runtimeRecord, killDependencies);
		try {
			// oxlint-disable-next-line no-await-in-loop -- per-record cleanup is intentionally serial
			await deleteRecord(options.stateDir, runtimeRecord.leaseId);
		} catch (error) {
			const warning = `Failed to remove stale tool VM runtime record for lease '${runtimeRecord.leaseId}' at '${options.stateDir}': ${error instanceof Error ? error.message : JSON.stringify(error)}`;
			log(warning);
			warnings.push(warning);
			if (killedPid !== null) {
				killedPids.push(killedPid);
			}
			continue;
		}
		log(
			killedPid === null
				? `Removed stale tool VM runtime record for lease '${runtimeRecord.leaseId}' after confirming the orphaned process was already gone.`
				: `Removed stale tool VM runtime record for lease '${runtimeRecord.leaseId}' after terminating orphaned tool VM pid ${killedPid}.`,
		);
		cleanedCount += 1;
		if (killedPid !== null) {
			killedPids.push(killedPid);
		}
	}

	return { cleanedCount, killedPids, quarantinedCount, warnings };
}
