import type {
	configureHostNetworkDefaults,
	HostNetworkDefaultsResult,
} from '@agent-vm/gondolin-adapter';
import type { SecretResolver } from '@agent-vm/secret-management';

import type { LoadedSystemConfig } from '../config/system-config.js';
import type { deleteGatewayRuntimeRecord } from '../gateway/gateway-runtime-record.js';
import type {
	preflightGatewayZoneStart,
	startGatewayZone,
} from '../gateway/gateway-zone-orchestrator.js';
import type { resolveControllerTelemetryIdentity } from '../observability/controller-telemetry-identity.js';
import type { startControllerTelemetry } from '../observability/controller-telemetry.js';
import type { checkObservabilityStackReadiness } from '../observability/observability-readiness.js';
import type { ControllerRuntimeZoneStatus } from '../operations/controller-status.js';
import type { RunTaskFn } from '../shared/run-task.js';
import type { ActiveWorkerTask } from './active-task-registry.js';
import type { appendDurableHealthEvent } from './health/durable-health-event-log.js';
import type {
	createControllerService,
	ObservedControllerLeaseCreateRequest,
} from './http/controller-http-routes.js';
import type { ToolVmProfile } from './leases/lease-manager.js';
import type { executeWorkerTask, prepareWorkerTask } from './worker-task-runner.js';
import type { ZoneGitCapabilityStore } from './zone-git/zone-git-capability-store.js';
import type { ZoneGitOperationLocks } from './zone-git/zone-git-operation-locks.js';
import type { ZoneGitToolVmMount } from './zone-git/zone-git-paths.js';

export interface ControllerRuntime {
	readonly controllerPort: number;
	readonly zones: readonly (ControllerRuntimeZoneStatus & {
		readonly zoneId: string;
	})[];
	close(): Promise<void>;
}

export interface ControllerRuntimeDependencies {
	readonly clearIntervalImpl?: (timer: NodeJS.Timeout) => void;
	readonly clearTimeoutImpl?: (timer: NodeJS.Timeout) => void;
	readonly appendDurableHealthEvent?: typeof appendDurableHealthEvent;
	readonly checkObservabilityStackReadiness?: typeof checkObservabilityStackReadiness;
	readonly configureHostNetworkDefaults?: typeof configureHostNetworkDefaults;
	readonly resolveControllerTelemetryIdentity?: typeof resolveControllerTelemetryIdentity;
	readonly resolveControllerTelemetryServiceVersion?: () => Promise<string>;
	readonly startControllerTelemetry?: typeof startControllerTelemetry;
	readonly createManagedToolVm?: (options: {
		readonly profile: ToolVmProfile;
		readonly tcpSlot: number;
		readonly hostWorkMountDir: string;
		readonly zoneGitMount?: ZoneGitToolVmMount;
		readonly zoneId: string;
		readonly secretResolver: SecretResolver;
	}) => Promise<import('@agent-vm/gondolin-adapter').ManagedVm>;
	readonly createSecretResolver?: (options: {
		readonly serviceAccountToken: string;
	}) => Promise<SecretResolver>;
	readonly deleteGatewayRuntimeRecord?: typeof deleteGatewayRuntimeRecord;
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
	readonly preflightGatewayZoneStart?: typeof preflightGatewayZoneStart;
	readonly setIntervalImpl?: (
		callback: () => void | Promise<void>,
		delayMs: number,
	) => NodeJS.Timeout;
	readonly setTimeoutImpl?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
	readonly startGatewayZone?: typeof startGatewayZone;
	readonly startHttpServer?: (options: {
		readonly app: ReturnType<typeof createControllerService>;
		readonly port: number;
	}) => Promise<{
		close(): Promise<void>;
	}>;
	readonly zoneGitCapabilityStore?: ZoneGitCapabilityStore;
	readonly zoneGitOperationLocks?: ZoneGitOperationLocks;
}

export type { HostNetworkDefaultsResult };

export interface StartControllerRuntimeOptions {
	readonly systemConfig: LoadedSystemConfig;
	readonly startupFailures?: readonly {
		readonly lastError: string;
		readonly zoneId: string;
	}[];
	readonly zoneIds?: readonly string[];
}
