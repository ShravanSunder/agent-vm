import type { SecretResolver } from '@agent-vm/gondolin-adapter';

import type { LoadedSystemConfig } from '../config/system-config.js';
import type { deleteGatewayRuntimeRecord } from '../gateway/gateway-runtime-record.js';
import type { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import type { RunTaskFn } from '../shared/run-task.js';
import type { ActiveWorkerTask } from './active-task-registry.js';
import type { createControllerService } from './http/controller-http-routes.js';
import type { ToolVmProfile } from './leases/lease-manager.js';
import type { executeWorkerTask, prepareWorkerTask } from './worker-task-runner.js';
import type { ZoneGitCapabilityStore } from './zone-git/zone-git-capability-store.js';
import type { ZoneGitOperationLocks } from './zone-git/zone-git-operation-locks.js';
import type { ZoneGitToolVmMount } from './zone-git/zone-git-paths.js';

export interface ControllerRuntime {
	readonly controllerPort: number;
	readonly zones: readonly {
		readonly ingress?: {
			readonly host: string;
			readonly port: number;
		};
		readonly lastError?: string;
		readonly lifecycleState: 'running' | 'failed' | 'stopped';
		readonly vmId?: string;
		readonly zoneId: string;
	}[];
	close(): Promise<void>;
}

export interface ControllerRuntimeDependencies {
	readonly clearIntervalImpl?: (timer: NodeJS.Timeout) => void;
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
	readonly setIntervalImpl?: (
		callback: () => void | Promise<void>,
		delayMs: number,
	) => NodeJS.Timeout;
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

export interface StartControllerRuntimeOptions {
	readonly systemConfig: LoadedSystemConfig;
	readonly startupFailures?: readonly {
		readonly lastError: string;
		readonly zoneId: string;
	}[];
	readonly zoneIds?: readonly string[];
}
