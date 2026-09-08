import type { ManagedGatewayBootContract } from '@agent-vm/gateway-lifecycle';
import type { ManagedVm, ManagedVmImageBuildResult } from '@agent-vm/managed-vm';

import type { SystemConfig } from '../../config/system-config.js';
import type { GatewayExpectedAdmissionCohort } from '../../gateway/gateway-aggregate-admission-state.js';
import type {
	GatewayZoneDestroyResult,
	GatewayZoneVmOperations,
} from '../../gateway/gateway-zone-support.js';
import type { ControllerRuntimeZoneStatus } from '../../operations/controller-status.js';
import type { GatewayDisposableControlSessionClient } from '../control-session/index.js';
import type { GatewayVmRecoverySourceKey } from '../health/gateway-vm-recovery-policy.js';
import type { GatewayEpochIdentity } from '../vm-ownership/vm-ownership-contracts.js';
import type { GatewayLifecycleOperationTrigger } from './gateway-lifecycle-operation-record.js';
import type {
	GatewayDiagnosisSnapshot,
	GatewayZoneLifecycleState,
} from './gateway-zone-state-machine.js';

export type ControllerZoneConfig = SystemConfig['zones'][number];

export interface GatewayZoneRuntimeHandle {
	readonly controlSession?: GatewayDisposableControlSessionClient | undefined;
	readonly bootContract: ManagedGatewayBootContract;
	destroyGateway(): Promise<GatewayZoneDestroyResult>;
	readonly executionModel: 'managed-gateway';
	readonly expectedCohort: GatewayExpectedAdmissionCohort;
	readonly gatewayIdentity: GatewayEpochIdentity;
	readonly image: ManagedVmImageBuildResult;
	readonly ingress: {
		readonly host: string;
		readonly port: number;
	};
	readonly vm: GatewayZoneVmOperations;
	readonly zone: ControllerZoneConfig;
}

export type ControllerZoneRuntimeSnapshot = ControllerRuntimeZoneStatus;

export interface ControllerZoneRuntimeBase {
	readonly gatewayType: ControllerZoneConfig['gateway']['type'];
	readonly zoneId: string;
	destroy(purge: boolean): Promise<{
		readonly ok: true;
		readonly purged: boolean;
		readonly zoneId: string;
	}>;
	getSnapshot(): ControllerZoneRuntimeSnapshot;
	shutdown(): Promise<void>;
}

export interface ManagedGatewayZoneRuntime extends ControllerZoneRuntimeBase {
	readonly gatewayType: 'hermes';
	coldStart(options?: ManagedGatewayZoneRestartOptions): Promise<ManagedGatewayZoneRestartResult>;
	enableSsh(): ReturnType<ManagedVm['enableSsh']>;
	exec(command: string): Promise<{
		readonly exitCode: number;
		readonly stderr: string;
		readonly stdout: string;
	}>;
	getHealth(): Promise<{
		readonly ok: boolean;
		readonly observation: string;
		readonly path?: string | undefined;
		readonly port?: number | undefined;
		readonly statusCode?: number | undefined;
		readonly zoneId: string;
	}>;
	getServiceHealth(): Promise<{
		readonly ok: boolean;
		readonly observation: string;
		readonly path?: string | undefined;
		readonly port?: number | undefined;
		readonly statusCode?: number | undefined;
		readonly zoneId: string;
	}>;
	getLifecycleState(): GatewayZoneLifecycleState;
	ensureCurrentControlSessionDialing(
		sourceKey: GatewayVmRecoverySourceKey,
	):
		| ReturnType<GatewayDisposableControlSessionClient['ensureDialing']>
		| { readonly status: 'control-session-unavailable' }
		| { readonly status: 'not-current' };
	getDiagnosis(): GatewayDiagnosisSnapshot;
	getLogs(): Promise<{ readonly output: string; readonly zoneId: string }>;
	refreshCredentials(options?: {
		readonly signal?: AbortSignal | undefined;
		readonly timeoutMs?: number | undefined;
	}): Promise<{ readonly ok: true; readonly zoneId: string }>;
	restart(options?: ManagedGatewayZoneRestartOptions): Promise<ManagedGatewayZoneRestartResult>;
	start(): Promise<void>;
	stop(): Promise<void>;
	upgrade(): Promise<{ readonly ok: true; readonly zoneId: string }>;
}

export interface ManagedGatewayZoneRestartResult {
	readonly leaseReleaseFailureCount: number;
	readonly operationId?: string | undefined;
}

export interface ManagedGatewayZoneRestartOptions {
	readonly operationTrigger?: GatewayLifecycleOperationTrigger | undefined;
	readonly timeoutMs?: number | undefined;
}

export type ControllerZoneRuntime = ManagedGatewayZoneRuntime;
