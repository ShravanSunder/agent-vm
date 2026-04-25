import type { GatewayProcessSpec } from '@agent-vm/gateway-interface';
import type { ManagedVm, SecretResolver } from '@agent-vm/gondolin-adapter';

import type { LoadedSystemConfig } from '../config/system-config.js';
import type { deleteGatewayRuntimeRecord } from '../gateway/gateway-runtime-record.js';
import type { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import type { RunTaskFn } from '../shared/run-task.js';
import type { ActiveWorkerTask } from './active-task-registry.js';
import type { createControllerService } from './http/controller-http-routes.js';
import type { ToolProfile } from './leases/lease-manager.js';
import type { executeWorkerTask, prepareWorkerTask } from './worker-task-runner.js';

export interface ControllerRuntime {
	readonly controllerPort: number;
	readonly gateway?: {
		readonly ingress: {
			readonly host: string;
			readonly port: number;
		};
		readonly processSpec: GatewayProcessSpec;
		readonly vm: Pick<ManagedVm, 'close' | 'id'>;
	};
	close(): Promise<void>;
}

export interface ControllerRuntimeDependencies {
	readonly clearIntervalImpl?: (timer: NodeJS.Timeout) => void;
	readonly createManagedToolVm?: (options: {
		readonly profile: ToolProfile;
		readonly tcpSlot: number;
		readonly workspaceDir: string;
		readonly zoneId: string;
	}) => Promise<ManagedVm>;
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
}

export interface StartControllerRuntimeOptions {
	readonly systemConfig: LoadedSystemConfig;
	readonly zoneId: string;
}
