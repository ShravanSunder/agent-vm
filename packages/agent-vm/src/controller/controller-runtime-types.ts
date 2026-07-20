import type {
	ManagedVm,
	ManagedVmExactProcessTerminationCapability,
	ManagedVmFactory,
	ManagedVmImageCapability,
	ManagedVmOwnedDirectoryCapability,
} from '@agent-vm/managed-vm';
import type { SecretResolver } from '@agent-vm/secret-management';

import type { LoadedSystemConfig } from '../config/system-config.js';
import type {
	preflightGatewayZoneStart,
	startGatewayZoneForController,
} from '../gateway/gateway-zone-orchestrator.js';
import type { resolveControllerTelemetryIdentity } from '../observability/controller-telemetry-identity.js';
import type { startControllerTelemetry } from '../observability/controller-telemetry.js';
import type { checkObservabilityStackReadiness } from '../observability/observability-readiness.js';
import type { reconcileRecordedVmTree } from '../operations/controller-offline-cleanup.js';
import type { ControllerRuntimeZoneStatus } from '../operations/controller-status.js';
import type { RunTaskFn } from '../shared/run-task.js';
import type { ActiveWorkerTask } from './active-task-registry.js';
import type { appendDurableHealthEvent } from './health/durable-health-event-log.js';
import type { createControllerService } from './http/controller-http-routes.js';
import type { ToolVmProfile } from './leases/lease-manager.js';
import type { ToolVmProvisioningHandle } from './leases/lease-manager.js';
import type { ObservedControllerLeaseCreateRequest } from './leases/observed-lease-create-request.js';
import type { acquireControllerOwnershipLock } from './vm-ownership/controller-ownership-lock.js';
import type { createGatewayOwnershipCoordinator } from './vm-ownership/gateway-ownership-coordinator.js';
import type { executeWorkerTask, prepareWorkerTask } from './worker-task-runner.js';
import type { WorkspaceGitOperationLocks } from './workspace-git/workspace-git-operation-locks.js';
import type { materializeWorkspaceGitRepository } from './workspace-git/workspace-git-operations.js';

export interface ControllerRuntime {
	readonly controllerPort: number;
	readonly zones: readonly (ControllerRuntimeZoneStatus & {
		readonly zoneId: string;
	})[];
	close(): Promise<void>;
}

export interface ManagedVmHostNetworkDefaults {
	readonly autoSelectFamily: false | 'unavailable';
	readonly dnsResultOrder: 'ipv4first' | 'unavailable';
}

export type ConfigureManagedVmHostNetworkDefaults = () => ManagedVmHostNetworkDefaults;

export interface ControllerRuntimeDependencies {
	readonly clearIntervalImpl?: (timer: NodeJS.Timeout) => void;
	readonly clearTimeoutImpl?: (timer: NodeJS.Timeout) => void;
	readonly appendDurableHealthEvent?: typeof appendDurableHealthEvent;
	readonly checkObservabilityStackReadiness?: typeof checkObservabilityStackReadiness;
	readonly configureManagedVmHostNetworkDefaults: ConfigureManagedVmHostNetworkDefaults;
	readonly managedVmFactory: ManagedVmFactory;
	readonly managedVmExactProcessTermination: ManagedVmExactProcessTerminationCapability;
	readonly managedVmImages: ManagedVmImageCapability;
	readonly managedVmOwnedDirectories: ManagedVmOwnedDirectoryCapability;
	readonly materializeWorkspaceGitRepository?: typeof materializeWorkspaceGitRepository;
	readonly controllerEpoch?: string;
	readonly acquireControllerOwnershipLock?: typeof acquireControllerOwnershipLock;
	readonly resolveControllerTelemetryIdentity?: typeof resolveControllerTelemetryIdentity;
	readonly resolveControllerTelemetryServiceVersion?: () => Promise<string>;
	readonly startControllerTelemetry?: typeof startControllerTelemetry;
	readonly createGatewayOwnershipCoordinator?: typeof createGatewayOwnershipCoordinator;
	readonly createManagedToolVm?: (options: {
		readonly agentId: string;
		readonly hostGitDirectoryRoot: string;
		readonly hostWorkspaceRoot: string;
		readonly profile: ToolVmProfile;
		readonly tcpSlot: number;
		readonly zoneId: string;
		readonly secretResolver: SecretResolver;
	}) => Promise<ManagedVm | ToolVmProvisioningHandle>;
	readonly createSecretResolver?: (options: {
		readonly serviceAccountToken: string;
	}) => Promise<SecretResolver>;
	readonly now?: () => number;
	readonly onLeaseCreateRequest?: (request: ObservedControllerLeaseCreateRequest) => void;
	// Injected by tests so the lease manager doesn't shell out to `ps` against
	// a fake managed-vm pid when capturing process identity for the runtime
	// record. Production omits this; the lease manager uses the real default.
	readonly isProcessAlive?: (pid: number) => boolean;
	readonly readProcessIdentity?: (
		pid: number,
	) => Promise<{ readonly command: string; readonly lstart: string } | null>;
	readonly runTask?: RunTaskFn;
	readonly prepareWorkerTask?: typeof prepareWorkerTask;
	readonly executeWorkerTask?: typeof executeWorkerTask;
	readonly onWorkerTaskPrepared?: (task: ActiveWorkerTask) => void | Promise<void>;
	readonly onWorkerTaskIngress?: (
		zoneId: string,
		taskId: string,
		workerIngress: { readonly host: string; readonly port: number },
	) => void | Promise<void>;
	readonly onWorkerTaskFinished?: (zoneId: string, taskId: string) => void | Promise<void>;
	readonly readIdentityPem?: (identityFilePath: string) => Promise<string>;
	readonly reconcileRecordedVmTree?: typeof reconcileRecordedVmTree;
	readonly preflightGatewayZoneStart?: typeof preflightGatewayZoneStart;
	readonly setIntervalImpl?: (
		callback: () => void | Promise<void>,
		delayMs: number,
	) => NodeJS.Timeout;
	readonly setTimeoutImpl?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
	readonly startGatewayZone?: typeof startGatewayZoneForController;
	readonly startHttpServer?: (options: {
		readonly app: ReturnType<typeof createControllerService>;
		readonly port: number;
	}) => Promise<{
		close(): Promise<void>;
	}>;
	readonly workspaceGitOperationLocks?: WorkspaceGitOperationLocks;
}

export interface StartControllerRuntimeOptions {
	readonly systemConfig: LoadedSystemConfig;
	readonly startupFailures?: readonly {
		readonly lastError: string;
		readonly zoneId: string;
	}[];
	readonly zoneIds?: readonly string[];
}
