import {
	isManagedVmProcess,
	isProcessAlive,
	killOrphanedManagedVmProcess,
	killProcess,
	readProcessCommand,
	readProcessIdentity,
	sleep,
} from '../shared/managed-vm-process.js';
import {
	readTcpListenPortOwner as defaultReadTcpListenPortOwner,
	type PortOwner,
} from '../shared/port-owner.js';
import type { GatewayRuntimeRecord } from './gateway-runtime-record.js';
import {
	deleteGatewayRuntimeRecord,
	loadGatewayRuntimeRecordResult,
} from './gateway-runtime-record.js';

function writeRecoveryLog(message: string): void {
	process.stderr.write(`[agent-vm] ${message}\n`);
}

function expectedGatewaySessionLabel(projectNamespace: string, zoneId: string): string {
	return `${projectNamespace}:${zoneId}:gateway`;
}

function validateRuntimeRecordCleanupScope(options: {
	readonly projectNamespace: string;
	readonly runtimeRecord: GatewayRuntimeRecord;
	readonly stateDir: string;
	readonly zoneId: string;
}): string | null {
	if (options.runtimeRecord.projectNamespace !== options.projectNamespace) {
		return `Gateway runtime record at '${options.stateDir}' for zone '${options.runtimeRecord.zoneId}' belongs to projectNamespace '${options.runtimeRecord.projectNamespace}', not '${options.projectNamespace}'. Refusing scoped cleanup.`;
	}
	if (options.runtimeRecord.zoneId !== options.zoneId) {
		return `Gateway runtime record at '${options.stateDir}' belongs to zone '${options.runtimeRecord.zoneId}', not requested zone '${options.zoneId}'. Refusing scoped cleanup.`;
	}
	const expectedSessionLabel = expectedGatewaySessionLabel(
		options.projectNamespace,
		options.zoneId,
	);
	if (options.runtimeRecord.sessionLabel !== expectedSessionLabel) {
		return `Gateway runtime record at '${options.stateDir}' session label '${options.runtimeRecord.sessionLabel}' does not match expected '${expectedSessionLabel}'. Refusing scoped cleanup.`;
	}
	return null;
}

async function killOrphanedGatewayProcess(
	runtimeRecord: GatewayRuntimeRecord,
	dependencies: Required<
		Pick<
			GatewayRecoveryDependencies,
			'isProcessAlive' | 'killProcess' | 'readProcessCommand' | 'readProcessIdentity' | 'sleep'
		>
	>,
): Promise<number | null> {
	return await killOrphanedManagedVmProcess({
		contextLabel: `Gateway runtime record for zone '${runtimeRecord.zoneId}'`,
		dependencies,
		pid: runtimeRecord.qemuPid,
		recordedIdentity: runtimeRecord.processIdentity,
	});
}

type GatewayPortOwnershipProof =
	| { readonly kind: 'owned' }
	| { readonly kind: 'record-stale' }
	| { readonly kind: 'unproven'; readonly warning: string };

async function verifyGatewayPortOwnership(options: {
	readonly readTcpListenPortOwner: (port: number) => Promise<PortOwner | null>;
	readonly runtimeRecord: GatewayRuntimeRecord;
}): Promise<GatewayPortOwnershipProof> {
	const portOwner = await options.readTcpListenPortOwner(options.runtimeRecord.ingressPort);
	if (portOwner === null) {
		return { kind: 'record-stale' };
	}
	if (portOwner.pid !== options.runtimeRecord.qemuPid) {
		return {
			kind: 'unproven',
			warning: `Gateway runtime record for zone '${options.runtimeRecord.zoneId}' port ${String(options.runtimeRecord.ingressPort)} is held by pid ${String(portOwner.pid)}, expected pid ${String(options.runtimeRecord.qemuPid)}.`,
		};
	}
	if (!isManagedVmProcess(portOwner.command)) {
		return {
			kind: 'unproven',
			warning: `Gateway runtime record for zone '${options.runtimeRecord.zoneId}' port ${String(options.runtimeRecord.ingressPort)} is held by pid ${String(portOwner.pid)} but command is not a managed VM process: ${portOwner.command}.`,
		};
	}
	return { kind: 'owned' };
}

export interface GatewayRecoveryDependencies {
	readonly deleteGatewayRuntimeRecord?: typeof deleteGatewayRuntimeRecord;
	readonly isProcessAlive?: (pid: number) => boolean;
	readonly killProcess?: (pid: number, signal: NodeJS.Signals) => void;
	readonly loadGatewayRuntimeRecordResult?: typeof loadGatewayRuntimeRecordResult;
	readonly log?: (message: string) => void;
	readonly readProcessCommand?: (pid: number) => Promise<string | null>;
	readonly readProcessIdentity?: typeof readProcessIdentity;
	readonly readTcpListenPortOwner?: (port: number) => Promise<PortOwner | null>;
	readonly sleep?: (delayMs: number) => Promise<void>;
}

export async function cleanupOrphanedGatewayIfPresent(
	options: {
		readonly mode?: 'in-process-recovery' | 'offline-cleanup';
		readonly projectNamespace: string;
		readonly stateDir: string;
		readonly zoneId: string;
	},
	dependencies: GatewayRecoveryDependencies = {},
): Promise<{
	readonly cleanedUp: boolean;
	readonly cleanupWarning?: string;
	readonly killedPid: number | null;
}> {
	const log = dependencies.log ?? writeRecoveryLog;
	const runtimeRecordResult = await (
		dependencies.loadGatewayRuntimeRecordResult ?? loadGatewayRuntimeRecordResult
	)(options.stateDir);
	if (runtimeRecordResult.kind === 'missing') {
		return { cleanedUp: false, killedPid: null };
	}
	if (runtimeRecordResult.kind === 'parse-error') {
		const cleanupWarning = `Malformed gateway runtime record '${runtimeRecordResult.path}': ${runtimeRecordResult.error.message}.`;
		if (options.mode !== 'in-process-recovery') {
			throw new Error(cleanupWarning, { cause: runtimeRecordResult.error });
		}
		log(`Skipping ${cleanupWarning}`);
		return {
			cleanedUp: false,
			cleanupWarning,
			killedPid: null,
		};
	}
	const runtimeRecord = runtimeRecordResult.record;
	const scopeMismatch = validateRuntimeRecordCleanupScope({
		projectNamespace: options.projectNamespace,
		runtimeRecord,
		stateDir: options.stateDir,
		zoneId: options.zoneId,
	});
	if (scopeMismatch !== null) {
		if (options.mode !== 'in-process-recovery') {
			throw new Error(scopeMismatch);
		}
		const cleanupWarning = `${scopeMismatch} Skipping the stale runtime record without signaling its recorded process during in-process recovery.`;
		log(cleanupWarning);
		return {
			cleanedUp: false,
			cleanupWarning,
			killedPid: null,
		};
	}
	log(
		`Found persisted gateway runtime for zone '${runtimeRecord.zoneId}' (pid ${runtimeRecord.qemuPid}, vm ${runtimeRecord.vmId}).`,
	);

	const portOwnershipProof = await verifyGatewayPortOwnership({
		readTcpListenPortOwner: dependencies.readTcpListenPortOwner ?? defaultReadTcpListenPortOwner,
		runtimeRecord,
	});
	if (portOwnershipProof.kind === 'unproven') {
		if (options.mode !== 'in-process-recovery') {
			throw new Error(portOwnershipProof.warning);
		}
		const cleanupWarning = `Skipping ${portOwnershipProof.warning}`;
		log(cleanupWarning);
		return {
			cleanedUp: false,
			cleanupWarning,
			killedPid: null,
		};
	}
	if (portOwnershipProof.kind === 'record-stale') {
		try {
			await (dependencies.deleteGatewayRuntimeRecord ?? deleteGatewayRuntimeRecord)(
				options.stateDir,
			);
		} catch (error) {
			const cleanupWarning = `Failed to remove stale gateway runtime record for zone '${runtimeRecord.zoneId}' at '${options.stateDir}': ${error instanceof Error ? error.message : JSON.stringify(error)}`;
			log(cleanupWarning);
			return {
				cleanedUp: false,
				cleanupWarning,
				killedPid: null,
			};
		}
		log(
			`Removed stale gateway runtime record for zone '${runtimeRecord.zoneId}' after confirming its TCP listener was already gone.`,
		);
		return {
			cleanedUp: true,
			killedPid: null,
		};
	}

	const killedPid = await killOrphanedGatewayProcess(runtimeRecord, {
		isProcessAlive: dependencies.isProcessAlive ?? isProcessAlive,
		killProcess: dependencies.killProcess ?? killProcess,
		readProcessCommand: dependencies.readProcessCommand ?? readProcessCommand,
		readProcessIdentity: dependencies.readProcessIdentity ?? readProcessIdentity,
		sleep: dependencies.sleep ?? sleep,
	});
	try {
		await (dependencies.deleteGatewayRuntimeRecord ?? deleteGatewayRuntimeRecord)(options.stateDir);
	} catch (error) {
		const cleanupWarning = `Failed to remove stale gateway runtime record for zone '${runtimeRecord.zoneId}' at '${options.stateDir}': ${error instanceof Error ? error.message : JSON.stringify(error)}`;
		log(cleanupWarning);
		return {
			cleanedUp: false,
			cleanupWarning,
			killedPid,
		};
	}
	log(
		killedPid === null
			? `Removed stale gateway runtime record for zone '${runtimeRecord.zoneId}' after confirming the orphaned process was already gone.`
			: `Removed stale gateway runtime record for zone '${runtimeRecord.zoneId}' after terminating orphaned gateway pid ${killedPid}.`,
	);

	return {
		cleanedUp: true,
		killedPid,
	};
}
