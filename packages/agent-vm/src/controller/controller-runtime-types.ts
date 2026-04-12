import type { GatewayProcessSpec } from 'gateway-interface';
import type { ManagedVm, SecretResolver } from 'gondolin-core';

import type { SystemConfig } from '../config/system-config.js';
import type { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import type { RunTaskFn } from '../shared/run-task.js';
import type { createControllerService } from './http/controller-http-routes.js';
import type { ToolProfile } from './leases/lease-manager.js';

export interface ControllerRuntime {
	readonly controllerPort: number;
	readonly gateway: {
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
	readonly now?: () => number;
	readonly runTask?: RunTaskFn;
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
	readonly systemConfig: SystemConfig;
	readonly zoneId: string;
}
