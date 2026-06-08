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
import {
	GatewayOwnershipUnsafeError,
	type GatewayOwnershipEvidence,
} from './gateway-ownership-evidence.js';
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

type RuntimeRecordCleanupScopeValidationResult =
	| { readonly kind: 'ok' }
	| {
			readonly evidence: Extract<
				GatewayOwnershipEvidence,
				{ readonly kind: 'record-scope-mismatch' }
			>;
			readonly kind: 'mismatch';
			readonly warning: string;
	  };

function validateRuntimeRecordCleanupScope(options: {
	readonly expectedConfigPath: string;
	readonly expectedControllerPort: number;
	readonly projectNamespace: string;
	readonly runtimeRecord: GatewayRuntimeRecord;
	readonly stateDir: string;
	readonly zoneId: string;
}): RuntimeRecordCleanupScopeValidationResult {
	if (options.runtimeRecord.configPath !== options.expectedConfigPath) {
		return {
			evidence: {
				actualScope: `configPath:${options.runtimeRecord.configPath}`,
				expectedScope: `configPath:${options.expectedConfigPath}`,
				kind: 'record-scope-mismatch',
			},
			kind: 'mismatch',
			warning: `Gateway runtime record at '${options.stateDir}' for zone '${options.runtimeRecord.zoneId}' belongs to configPath '${options.runtimeRecord.configPath}', not '${options.expectedConfigPath}'. Refusing scoped cleanup.`,
		};
	}
	if (options.runtimeRecord.controllerPort !== options.expectedControllerPort) {
		return {
			evidence: {
				actualScope: `controllerPort:${String(options.runtimeRecord.controllerPort)}`,
				expectedScope: `controllerPort:${String(options.expectedControllerPort)}`,
				kind: 'record-scope-mismatch',
			},
			kind: 'mismatch',
			warning: `Gateway runtime record at '${options.stateDir}' for zone '${options.runtimeRecord.zoneId}' belongs to controllerPort '${String(options.runtimeRecord.controllerPort)}', not '${String(options.expectedControllerPort)}'. Refusing scoped cleanup.`,
		};
	}
	if (options.runtimeRecord.projectNamespace !== options.projectNamespace) {
		return {
			evidence: {
				actualScope: `projectNamespace:${options.runtimeRecord.projectNamespace}`,
				expectedScope: `projectNamespace:${options.projectNamespace}`,
				kind: 'record-scope-mismatch',
			},
			kind: 'mismatch',
			warning: `Gateway runtime record at '${options.stateDir}' for zone '${options.runtimeRecord.zoneId}' belongs to projectNamespace '${options.runtimeRecord.projectNamespace}', not '${options.projectNamespace}'. Refusing scoped cleanup.`,
		};
	}
	if (options.runtimeRecord.zoneId !== options.zoneId) {
		return {
			evidence: {
				actualScope: `zoneId:${options.runtimeRecord.zoneId}`,
				expectedScope: `zoneId:${options.zoneId}`,
				kind: 'record-scope-mismatch',
			},
			kind: 'mismatch',
			warning: `Gateway runtime record at '${options.stateDir}' belongs to zone '${options.runtimeRecord.zoneId}', not requested zone '${options.zoneId}'. Refusing scoped cleanup.`,
		};
	}
	const expectedSessionLabel = expectedGatewaySessionLabel(
		options.projectNamespace,
		options.zoneId,
	);
	if (options.runtimeRecord.sessionLabel !== expectedSessionLabel) {
		return {
			evidence: {
				actualScope: `sessionLabel:${options.runtimeRecord.sessionLabel}`,
				expectedScope: `sessionLabel:${expectedSessionLabel}`,
				kind: 'record-scope-mismatch',
			},
			kind: 'mismatch',
			warning: `Gateway runtime record at '${options.stateDir}' session label '${options.runtimeRecord.sessionLabel}' does not match expected '${expectedSessionLabel}'. Refusing scoped cleanup.`,
		};
	}
	return { kind: 'ok' };
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
	| {
			readonly evidence: Extract<
				GatewayOwnershipEvidence,
				{ readonly kind: 'port-owner-mismatch' | 'unmanaged-port-owner' }
			>;
			readonly kind: 'unproven';
			readonly warning: string;
	  };

export type MissingGatewayRuntimeRecordPortPreflight =
	| { readonly kind: 'clear' }
	| {
			readonly evidence: Extract<
				GatewayOwnershipEvidence,
				{ readonly kind: 'missing-record-port-owned' }
			>;
			readonly kind: 'blocked';
	  };

export async function checkMissingGatewayRuntimeRecordPortPreflight(options: {
	readonly expectedControllerPid?: number | undefined;
	readonly gatewayIngressPort: number;
	readonly readTcpListenPortOwner: (port: number) => Promise<PortOwner | null>;
}): Promise<MissingGatewayRuntimeRecordPortPreflight> {
	const portOwner = await options.readTcpListenPortOwner(options.gatewayIngressPort);
	if (portOwner === null) {
		return { kind: 'clear' };
	}
	if (portOwner.pid === options.expectedControllerPid) {
		return { kind: 'clear' };
	}
	return {
		evidence: {
			kind: 'missing-record-port-owned',
			ownerCommand: portOwner.command,
			ownerPid: portOwner.pid,
			port: options.gatewayIngressPort,
		},
		kind: 'blocked',
	};
}

async function verifyGatewayPortOwnership(options: {
	readonly expectedControllerPid?: number | undefined;
	readonly readTcpListenPortOwner: (port: number) => Promise<PortOwner | null>;
	readonly runtimeRecord: GatewayRuntimeRecord;
}): Promise<GatewayPortOwnershipProof> {
	const portOwner = await options.readTcpListenPortOwner(options.runtimeRecord.ingressPort);
	if (portOwner === null) {
		return { kind: 'record-stale' };
	}
	if (portOwner.pid === options.expectedControllerPid) {
		return { kind: 'owned' };
	}
	if (portOwner.pid !== options.runtimeRecord.qemuPid) {
		return {
			evidence: {
				expectedPid: options.runtimeRecord.qemuPid,
				kind: 'port-owner-mismatch',
				ownerPid: portOwner.pid,
				port: options.runtimeRecord.ingressPort,
			},
			kind: 'unproven',
			warning: `Gateway runtime record for zone '${options.runtimeRecord.zoneId}' port ${String(options.runtimeRecord.ingressPort)} is held by pid ${String(portOwner.pid)}, expected pid ${String(options.runtimeRecord.qemuPid)}.`,
		};
	}
	if (!isManagedVmProcess(portOwner.command)) {
		return {
			evidence: {
				kind: 'unmanaged-port-owner',
				ownerCommand: portOwner.command,
				ownerPid: portOwner.pid,
				port: options.runtimeRecord.ingressPort,
			},
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
		readonly configuredIngressPort?: number | undefined;
		readonly expectedConfigPath: string;
		readonly expectedControllerPort: number;
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
	readonly ownershipEvidence?: GatewayOwnershipEvidence | undefined;
}> {
	const log = dependencies.log ?? writeRecoveryLog;
	const runtimeRecordResult = await (
		dependencies.loadGatewayRuntimeRecordResult ?? loadGatewayRuntimeRecordResult
	)(options.stateDir);
	const expectedControllerPid = options.mode === 'in-process-recovery' ? process.pid : undefined;
	if (runtimeRecordResult.kind === 'missing') {
		if (options.configuredIngressPort !== undefined) {
			const portPreflight = await checkMissingGatewayRuntimeRecordPortPreflight({
				...(expectedControllerPid === undefined ? {} : { expectedControllerPid }),
				gatewayIngressPort: options.configuredIngressPort,
				readTcpListenPortOwner:
					dependencies.readTcpListenPortOwner ?? defaultReadTcpListenPortOwner,
			});
			if (portPreflight.kind === 'blocked') {
				throw new GatewayOwnershipUnsafeError({
					evidence: portPreflight.evidence,
					message: `Gateway runtime record is missing but configured ingress port ${String(portPreflight.evidence.port)} is owned by pid ${String(portPreflight.evidence.ownerPid)} (${portPreflight.evidence.ownerCommand}). Refusing gateway cold-start until ownership is resolved.`,
				});
			}
		}
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
			ownershipEvidence: {
				kind: 'record-parse-error',
				message: runtimeRecordResult.error.message,
				path: runtimeRecordResult.path,
			},
		};
	}
	const runtimeRecord = runtimeRecordResult.record;
	const scopeMismatch = validateRuntimeRecordCleanupScope({
		expectedConfigPath: options.expectedConfigPath,
		expectedControllerPort: options.expectedControllerPort,
		projectNamespace: options.projectNamespace,
		runtimeRecord,
		stateDir: options.stateDir,
		zoneId: options.zoneId,
	});
	if (scopeMismatch.kind === 'mismatch') {
		if (options.mode !== 'in-process-recovery') {
			throw new Error(scopeMismatch.warning);
		}
		const cleanupWarning = `${scopeMismatch.warning} Skipping the stale runtime record without signaling its recorded process during in-process recovery.`;
		log(cleanupWarning);
		return {
			cleanedUp: false,
			cleanupWarning,
			killedPid: null,
			ownershipEvidence: scopeMismatch.evidence,
		};
	}
	log(
		`Found persisted gateway runtime for zone '${runtimeRecord.zoneId}' (pid ${runtimeRecord.qemuPid}, vm ${runtimeRecord.vmId}).`,
	);

	const portOwnershipProof = await verifyGatewayPortOwnership({
		...(expectedControllerPid === undefined ? {} : { expectedControllerPid }),
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
			ownershipEvidence: portOwnershipProof.evidence,
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
