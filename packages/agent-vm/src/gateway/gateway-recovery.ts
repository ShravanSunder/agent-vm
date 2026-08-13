import type { ManagedVmExactProcessTerminationCapability } from '@agent-vm/managed-vm';

import {
	writeControllerDiagnostic,
	type ControllerDiagnosticLevel,
	type ControllerDiagnosticTelemetry,
} from '../controller/controller-diagnostic-logging.js';
import type { ControllerManagedGatewayRuntimeRecordTarget } from '../controller/durable-state/controller-state-record-paths.js';
import { terminateRecordedManagedVmProcess } from '../shared/controller-managed-vm-termination.js';
import { isManagedVmProcess } from '../shared/managed-vm-process.js';
import type { readProcessIdentity } from '../shared/managed-vm-process.js';
import {
	readTcpListenPortOwner as defaultReadTcpListenPortOwner,
	type PortOwner,
} from '../shared/port-owner.js';
import {
	GatewayOwnershipUnsafeError,
	type GatewayOwnershipEvidence,
} from './gateway-ownership-evidence.js';
import type { ManagedGatewayRuntimeRecord } from './gateway-runtime-record.js';
import {
	deleteManagedGatewayRuntimeRecord,
	loadManagedGatewayRuntimeRecordResult,
} from './gateway-runtime-record.js';

function writeRecoveryLog(
	level: ControllerDiagnosticLevel,
	telemetry: ControllerDiagnosticTelemetry = { operation: 'gateway-recovery' },
): void {
	writeControllerDiagnostic(
		'gateway',
		level === 'warning'
			? { event: 'gateway-recovery-diagnostic', failureClass: 'failure', level, telemetry }
			: { event: 'gateway-recovery-diagnostic', level, telemetry },
	);
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
	readonly runtimeRecord: ManagedGatewayRuntimeRecord;
	readonly runtimeRecordPath: string;
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
			warning: `Gateway runtime record at '${options.runtimeRecordPath}' for zone '${options.runtimeRecord.zoneId}' belongs to configPath '${options.runtimeRecord.configPath}', not '${options.expectedConfigPath}'. Refusing scoped cleanup.`,
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
			warning: `Gateway runtime record at '${options.runtimeRecordPath}' for zone '${options.runtimeRecord.zoneId}' belongs to controllerPort '${String(options.runtimeRecord.controllerPort)}', not '${String(options.expectedControllerPort)}'. Refusing scoped cleanup.`,
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
			warning: `Gateway runtime record at '${options.runtimeRecordPath}' for zone '${options.runtimeRecord.zoneId}' belongs to projectNamespace '${options.runtimeRecord.projectNamespace}', not '${options.projectNamespace}'. Refusing scoped cleanup.`,
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
			warning: `Gateway runtime record at '${options.runtimeRecordPath}' belongs to zone '${options.runtimeRecord.zoneId}', not requested zone '${options.zoneId}'. Refusing scoped cleanup.`,
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
			warning: `Gateway runtime record at '${options.runtimeRecordPath}' session label '${options.runtimeRecord.sessionLabel}' does not match expected '${expectedSessionLabel}'. Refusing scoped cleanup.`,
		};
	}
	return { kind: 'ok' };
}

async function terminateRecordedGatewayVmProcess(
	runtimeRecord: ManagedGatewayRuntimeRecord,
	dependencies: Required<Pick<GatewayRecoveryDependencies, 'exactProcessTermination'>>,
): Promise<number | null> {
	const outcome = await terminateRecordedManagedVmProcess({
		contextLabel: `Gateway runtime record for zone '${runtimeRecord.zoneId}'`,
		exactProcessTermination: dependencies.exactProcessTermination,
		target: {
			hostPid: runtimeRecord.qemuPid,
			processIdentity: runtimeRecord.processIdentity,
			vmId: runtimeRecord.vmId,
		},
	});
	return outcome.kind === 'already-absent' ? null : outcome.pid;
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
	readonly runtimeRecord: ManagedGatewayRuntimeRecord;
}): Promise<GatewayPortOwnershipProof> {
	if (options.runtimeRecord.ingressPort === undefined) {
		return { kind: 'owned' };
	}
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
	readonly deleteManagedGatewayRuntimeRecord?: typeof deleteManagedGatewayRuntimeRecord;
	readonly exactProcessTermination: ManagedVmExactProcessTerminationCapability;
	readonly loadManagedGatewayRuntimeRecordResult?: typeof loadManagedGatewayRuntimeRecordResult;
	readonly log?: (
		level: ControllerDiagnosticLevel,
		telemetry?: ControllerDiagnosticTelemetry,
	) => void;
	readonly readProcessIdentity?: typeof readProcessIdentity;
	readonly readTcpListenPortOwner?: (port: number) => Promise<PortOwner | null>;
}

export interface GatewayRecordedRuntimeCleanupOptions {
	readonly configuredIngressPort?: number | undefined;
	readonly expectedConfigPath: string;
	readonly expectedControllerPort: number;
	readonly mode?: 'in-process-recovery' | 'offline-cleanup';
	readonly projectNamespace: string;
	readonly runtimeRecordTarget: ControllerManagedGatewayRuntimeRecordTarget;
	readonly zoneId: string;
}

export async function preflightRecordedGatewayRuntimeCleanup(
	options: GatewayRecordedRuntimeCleanupOptions,
	dependencies: Pick<
		GatewayRecoveryDependencies,
		'loadManagedGatewayRuntimeRecordResult' | 'log' | 'readTcpListenPortOwner'
	> = {},
): Promise<{
	readonly cleanupWarning?: string;
	readonly ownershipEvidence?: GatewayOwnershipEvidence | undefined;
}> {
	const log = dependencies.log ?? writeRecoveryLog;
	const runtimeRecordResult = await (
		dependencies.loadManagedGatewayRuntimeRecordResult ?? loadManagedGatewayRuntimeRecordResult
	)(options.runtimeRecordTarget);
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
		return {};
	}
	if (runtimeRecordResult.kind === 'parse-error') {
		const cleanupWarning = `Malformed gateway runtime record '${runtimeRecordResult.path}': ${runtimeRecordResult.error.message}.`;
		if (options.mode !== 'in-process-recovery') {
			throw new Error(cleanupWarning, { cause: runtimeRecordResult.error });
		}
		log('warning', {
			operation: 'load-gateway-runtime-record',
			zoneId: options.zoneId,
		});
		return {
			cleanupWarning,
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
		runtimeRecordPath: options.runtimeRecordTarget.filePath,
		zoneId: options.zoneId,
	});
	if (scopeMismatch.kind === 'mismatch') {
		if (options.mode !== 'in-process-recovery') {
			throw new Error(scopeMismatch.warning);
		}
		const cleanupWarning = `${scopeMismatch.warning} Skipping the stale runtime record without signaling its recorded process during in-process recovery.`;
		log('warning', {
			operation: 'validate-gateway-runtime-record-scope',
			zoneId: options.zoneId,
		});
		return {
			cleanupWarning,
			ownershipEvidence: scopeMismatch.evidence,
		};
	}
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
		log('warning', {
			operation: 'verify-gateway-port-ownership',
			zoneId: options.zoneId,
		});
		return {
			cleanupWarning,
			ownershipEvidence: portOwnershipProof.evidence,
		};
	}
	return {};
}

export async function cleanupRecordedGatewayRuntime(
	options: GatewayRecordedRuntimeCleanupOptions,
	dependencies: GatewayRecoveryDependencies,
): Promise<{
	readonly cleanedUp: boolean;
	readonly cleanupWarning?: string;
	readonly killedPid: number | null;
	readonly ownershipEvidence?: GatewayOwnershipEvidence | undefined;
}> {
	const log = dependencies.log ?? writeRecoveryLog;
	const runtimeRecordResult = await (
		dependencies.loadManagedGatewayRuntimeRecordResult ?? loadManagedGatewayRuntimeRecordResult
	)(options.runtimeRecordTarget);
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
		log('warning', {
			operation: 'load-gateway-runtime-record',
			zoneId: options.zoneId,
		});
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
		runtimeRecordPath: options.runtimeRecordTarget.filePath,
		zoneId: options.zoneId,
	});
	if (scopeMismatch.kind === 'mismatch') {
		if (options.mode !== 'in-process-recovery') {
			throw new Error(scopeMismatch.warning);
		}
		const cleanupWarning = `${scopeMismatch.warning} Skipping the stale runtime record without signaling its recorded process during in-process recovery.`;
		log('warning', {
			operation: 'validate-gateway-runtime-record-scope',
			zoneId: options.zoneId,
		});
		return {
			cleanedUp: false,
			cleanupWarning,
			killedPid: null,
			ownershipEvidence: scopeMismatch.evidence,
		};
	}
	log('info', { operation: 'inspect-gateway-runtime-record', zoneId: runtimeRecord.zoneId });

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
		log('warning', {
			operation: 'verify-gateway-port-ownership',
			zoneId: runtimeRecord.zoneId,
		});
		return {
			cleanedUp: false,
			cleanupWarning,
			killedPid: null,
			ownershipEvidence: portOwnershipProof.evidence,
		};
	}
	const killedPid = await terminateRecordedGatewayVmProcess(runtimeRecord, {
		exactProcessTermination: dependencies.exactProcessTermination,
	});
	try {
		await (dependencies.deleteManagedGatewayRuntimeRecord ?? deleteManagedGatewayRuntimeRecord)(
			options.runtimeRecordTarget,
		);
	} catch (error) {
		const cleanupWarning = `Failed to remove stale gateway runtime record for zone '${runtimeRecord.zoneId}' at '${options.runtimeRecordTarget.filePath}': ${error instanceof Error ? error.message : JSON.stringify(error)}`;
		log('warning', {
			operation: 'delete-gateway-runtime-record',
			zoneId: runtimeRecord.zoneId,
		});
		return {
			cleanedUp: false,
			cleanupWarning,
			killedPid,
		};
	}
	log('info', { operation: 'remove-gateway-runtime-record', zoneId: runtimeRecord.zoneId });

	return {
		cleanedUp: true,
		killedPid,
	};
}
