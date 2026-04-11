import type { ManagedVm, SecretResolver } from 'gondolin-core';

import type { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import type { createControllerService } from './controller-http-routes.js';
import type { ToolProfile } from './lease-manager.js';
import type { SystemConfig } from './system-config.js';

export interface ControllerRuntime {
	readonly controllerPort: number;
	readonly gateway: {
		readonly ingress: {
			readonly host: string;
			readonly port: number;
		};
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
	readonly pluginSourceDir: string;
	readonly systemConfig: SystemConfig;
	readonly zoneId: string;
}
