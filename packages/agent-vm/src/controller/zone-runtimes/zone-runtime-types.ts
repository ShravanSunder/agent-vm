import type { TaskState } from '@agent-vm/agent-vm-worker';
import type { GatewayProcessSpec } from '@agent-vm/gateway-interface';
import type { ManagedVm } from '@agent-vm/gondolin-adapter';
import type { SecretResolver } from '@agent-vm/secret-management';

import type { LoadedSystemConfig, SystemConfig } from '../../config/system-config.js';
import type { GatewayZoneStartResult } from '../../gateway/gateway-zone-support.js';
import type { ControllerRuntimeZoneStatus } from '../../operations/controller-status.js';
import type { RunTaskFn } from '../../shared/run-task.js';
import type { ActiveTaskRegistry } from '../active-task-registry.js';
import type { PullDefaultRequest, PullDefaultResult } from '../git-pull-default-operations.js';
import type { PushBranchRequest, PushBranchResult } from '../git-push-operations.js';
import type { LeaseManager, ToolVmProfile } from '../leases/lease-manager.js';
import type { RequestHeartbeatRegistry } from '../request-heartbeat-registry.js';
import type {
	PreparedWorkerTask,
	WorkerTaskInput,
	WorkerTaskResult,
} from '../worker-task-runner.js';
import type { ZoneGitToolVmMount } from '../zone-git/zone-git-paths.js';

export type ControllerZoneConfig = SystemConfig['zones'][number];

export interface GatewayZoneRuntimeHandle {
	readonly ingress: GatewayZoneStartResult['ingress'];
	readonly processSpec: GatewayProcessSpec;
	readonly vm: Pick<ManagedVm, 'close' | 'enableSsh' | 'exec' | 'getHostPid' | 'id'>;
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

export interface OpenClawZoneRuntime extends ControllerZoneRuntimeBase {
	readonly gatewayType: 'openclaw';
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
	getLogs(): Promise<{ readonly output: string; readonly zoneId: string }>;
	refreshCredentials(): Promise<{ readonly ok: true; readonly zoneId: string }>;
	restart(): Promise<OpenClawZoneRestartResult>;
	start(): Promise<void>;
	stop(): Promise<void>;
	upgrade(): Promise<{ readonly ok: true; readonly zoneId: string }>;
}

export interface OpenClawZoneRestartResult {
	readonly leaseReleaseFailureCount: number;
}

export interface WorkerZoneRuntime extends ControllerZoneRuntimeBase {
	readonly gatewayType: 'worker';
	closeTaskForZone(taskId: string): Promise<{ readonly status: 'closed' }>;
	executeWorkerTask(prepared: PreparedWorkerTask): Promise<WorkerTaskResult>;
	getTaskState(taskId: string): Promise<TaskState | null>;
	prepareWorkerTask(input: WorkerTaskInput): Promise<PreparedWorkerTask>;
	pullDefaultForTask(taskId: string, input: PullDefaultRequest): Promise<PullDefaultResult>;
	pushTaskBranches(
		taskId: string,
		input: { readonly branches: readonly PushBranchRequest[] },
	): Promise<{ readonly results: readonly PushBranchResult[] }>;
}

export type ControllerZoneRuntime = OpenClawZoneRuntime | WorkerZoneRuntime;

export interface SharedZoneRuntimeDependencies {
	readonly activeTaskRegistry: ActiveTaskRegistry;
	readonly controllerGithubToken: string | null;
	readonly createManagedToolVm: (options: {
		readonly profile: ToolVmProfile;
		readonly tcpSlot: number;
		readonly hostWorkMountDir: string;
		readonly zoneGitMount?: ZoneGitToolVmMount;
		readonly zoneId: string;
	}) => Promise<ManagedVm>;
	readonly deleteGatewayRuntimeRecord: (stateDirectory: string) => Promise<void>;
	readonly leaseManager: LeaseManager;
	readonly now: () => number;
	readonly requestHeartbeatRegistry: RequestHeartbeatRegistry;
	readonly runTask: RunTaskFn;
	readonly secretResolver: SecretResolver;
	readonly systemConfig: LoadedSystemConfig;
}
