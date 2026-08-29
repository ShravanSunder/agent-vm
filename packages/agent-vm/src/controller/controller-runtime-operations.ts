import { timingSafeEqual } from 'node:crypto';

import type { SecretRef, SecretResolver } from '@agent-vm/secret-management';

import type { SystemConfig } from '../config/system-config.js';
import {
	buildControllerStatus,
	buildControllerZoneStatus,
	type ControllerObservabilityStatus,
	type ControllerRuntimeStatus,
} from '../operations/controller-status.js';
import type {
	EnableSshForZoneOptions,
	ExecInZoneOptions,
} from './http/controller-http-route-support.js';
import {
	ControllerZoneAdminAuthError,
	ControllerZoneNotFoundError,
} from './zone-runtimes/zone-runtime-errors.js';
import type { ManagedGatewayZoneRuntime } from './zone-runtimes/zone-runtime-types.js';

interface ControllerRuntimeOperations {
	readonly destroyZone: (targetZoneId: string, purge: boolean) => Promise<unknown>;
	readonly enableSshForZone: (
		targetZoneId: string,
		options: EnableSshForZoneOptions,
	) => Promise<unknown>;
	readonly execInZone: (
		targetZoneId: string,
		command: string,
		options: ExecInZoneOptions,
	) => Promise<{
		readonly exitCode: number;
		readonly stderr: string;
		readonly stdout: string;
	}>;
	readonly getStatus: () => Promise<unknown>;
	readonly getZoneLogs: (targetZoneId: string) => Promise<{
		readonly output: string;
		readonly zoneId: string;
	}>;
	readonly getZoneHealth: (targetZoneId: string) => Promise<{
		readonly ok: boolean;
		readonly observation: string;
		readonly path?: string | undefined;
		readonly port?: number | undefined;
		readonly statusCode?: number | undefined;
		readonly zoneId: string;
	}>;
	readonly getZoneServiceHealth: (targetZoneId: string) => Promise<{
		readonly ok: boolean;
		readonly observation: string;
		readonly path?: string | undefined;
		readonly port?: number | undefined;
		readonly statusCode?: number | undefined;
		readonly zoneId: string;
	}>;
	readonly getZoneStatus: (targetZoneId: string) => Promise<unknown>;
	readonly refreshZoneCredentials: (targetZoneId: string) => Promise<{
		readonly ok: true;
		readonly zoneId: string;
	}>;
	readonly retireCredentialedRuntime: (
		targetZoneId: string,
		runtimeId: string,
		options: {
			readonly adminToken?: string;
			readonly agentId: string;
			readonly force: boolean;
		},
	) => Promise<unknown>;
	readonly upgradeZone: (targetZoneId: string) => Promise<unknown>;
}

export function createControllerRuntimeOperations(options: {
	readonly getActiveLeases: () => readonly { readonly zoneId: string }[];
	readonly getManagedGatewayRuntime: (
		zoneId: string,
	) => Pick<
		ManagedGatewayZoneRuntime,
		| 'destroy'
		| 'enableSsh'
		| 'exec'
		| 'getHealth'
		| 'getLogs'
		| 'getServiceHealth'
		| 'refreshCredentials'
		| 'upgrade'
	>;
	readonly destroyZoneRuntime: (
		zoneId: string,
		purge: boolean,
	) => Promise<{
		readonly ok: true;
		readonly purged: boolean;
		readonly zoneId: string;
	}>;
	readonly getRuntimeStatusByZone: () => ControllerRuntimeStatus['zones'];
	readonly getRuntimeDiagnosisByZone?: () => ControllerRuntimeStatus['diagnoses'];
	readonly getObservabilityStatus?: (() => ControllerObservabilityStatus) | undefined;
	readonly secretResolver: SecretResolver;
	readonly retireCredentialedRuntime?: (request: {
		readonly agentId: string;
		readonly force: boolean;
		readonly runtimeId: string;
		readonly zoneId: string;
	}) => Promise<unknown>;
	readonly systemConfig: SystemConfig;
}): ControllerRuntimeOperations {
	const buildRuntimeStatus = (): ControllerRuntimeStatus => {
		const zones = options.getRuntimeStatusByZone();
		const diagnoses = options.getRuntimeDiagnosisByZone?.();
		return {
			activeLeases: options.getActiveLeases(),
			...(diagnoses ? { diagnoses } : {}),
			...(zones ? { zones } : {}),
		};
	};

	const findZone = (targetZoneId: string): SystemConfig['zones'][number] => {
		const zone = options.systemConfig.zones.find(
			(candidateZone) => candidateZone.id === targetZoneId,
		);
		if (!zone) {
			throw new ControllerZoneNotFoundError(targetZoneId);
		}
		return zone;
	};

	return {
		destroyZone: async (targetZoneId, purge) =>
			await options.destroyZoneRuntime(targetZoneId, purge),
		enableSshForZone: async (targetZoneId, enableOptions) => {
			const zone = findZone(targetZoneId);
			await verifyZoneAdminAccess({
				providedToken: enableOptions.adminToken,
				secretResolver: options.secretResolver,
				zone,
			});
			const sshAccess = await options.getManagedGatewayRuntime(targetZoneId).enableSsh();
			return sshAccess;
		},
		execInZone: async (targetZoneId, command, execOptions) => {
			const zone = findZone(targetZoneId);
			await verifyZoneAdminAccess({
				providedToken: execOptions.adminToken,
				secretResolver: options.secretResolver,
				zone,
			});
			return await options.getManagedGatewayRuntime(targetZoneId).exec(command);
		},
		getStatus: async () =>
			buildControllerStatus(
				options.systemConfig,
				buildRuntimeStatus(),
				options.getObservabilityStatus?.(),
			),
		getZoneHealth: async (targetZoneId) =>
			await options.getManagedGatewayRuntime(targetZoneId).getHealth(),
		getZoneServiceHealth: async (targetZoneId) =>
			await options.getManagedGatewayRuntime(targetZoneId).getServiceHealth(),
		getZoneLogs: async (targetZoneId) =>
			await options.getManagedGatewayRuntime(targetZoneId).getLogs(),
		getZoneStatus: async (targetZoneId) => {
			findZone(targetZoneId);
			return buildControllerZoneStatus(options.systemConfig, targetZoneId, buildRuntimeStatus());
		},
		refreshZoneCredentials: async (targetZoneId) =>
			await options.getManagedGatewayRuntime(targetZoneId).refreshCredentials(),
		retireCredentialedRuntime: async (targetZoneId, runtimeId, retireOptions) => {
			const zone = findZone(targetZoneId);
			await verifyZoneAdminAccess({
				providedToken: retireOptions.adminToken,
				secretResolver: options.secretResolver,
				zone,
			});
			if (options.retireCredentialedRuntime === undefined) {
				throw new Error('Credentialed runtime retirement is unavailable.');
			}
			return await options.retireCredentialedRuntime({
				agentId: retireOptions.agentId,
				force: retireOptions.force,
				runtimeId,
				zoneId: targetZoneId,
			});
		},
		upgradeZone: async (targetZoneId) =>
			await options.getManagedGatewayRuntime(targetZoneId).upgrade(),
	};
}

function toSecretRef(secret: {
	readonly envVar?: string;
	readonly ref?: string;
	readonly source: '1password' | 'config' | 'environment';
	readonly value?: string;
}): SecretRef {
	switch (secret.source) {
		case 'environment':
			return {
				source: 'environment',
				ref: requireSecretReferenceField(secret.envVar, 'environment', 'envVar'),
			};
		case '1password':
			return {
				source: '1password',
				ref: requireSecretReferenceField(secret.ref, '1password', 'ref'),
			};
		case 'config':
			return {
				source: 'config',
				value: requireSecretReferenceField(secret.value, 'config', 'value'),
			};
		default: {
			const exhaustiveCheck: never = secret.source;
			throw new Error(`Unsupported secret source: ${String(exhaustiveCheck)}`);
		}
	}
}

function requireSecretReferenceField(
	value: string | undefined,
	source: '1password' | 'config' | 'environment',
	fieldName: string,
): string {
	if (value === undefined || value.trim().length === 0) {
		throw new Error(`Secret with source '${source}' is missing required '${fieldName}'.`);
	}
	return value;
}

function timingSafeEqualString(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	if (leftBuffer.length !== rightBuffer.length) {
		return false;
	}
	return timingSafeEqual(leftBuffer, rightBuffer);
}

async function verifyZoneAdminAccess(options: {
	readonly providedToken: string | undefined;
	readonly secretResolver: SecretResolver;
	readonly zone: SystemConfig['zones'][number];
}): Promise<void> {
	const adminAccess = options.zone.adminAccess ?? { mode: 'none' as const };
	if (adminAccess.mode === 'none') {
		return;
	}
	if (!options.providedToken) {
		throw new ControllerZoneAdminAuthError({
			code: 'zone-admin-auth-required',
			httpStatus: 401,
			zoneId: options.zone.id,
		});
	}

	const expectedToken = await options.secretResolver.resolve(toSecretRef(adminAccess.secret));
	if (!timingSafeEqualString(options.providedToken, expectedToken)) {
		throw new ControllerZoneAdminAuthError({
			code: 'zone-admin-auth-denied',
			httpStatus: 403,
			zoneId: options.zone.id,
		});
	}
}

export function createStopControllerOperation(options: {
	readonly clearReaperTimer: () => void;
	readonly closeControllerServer: () => Promise<void>;
	readonly stopAllZones: () => Promise<void>;
}): () => Promise<{ readonly ok: true }> {
	return async (): Promise<{ readonly ok: true }> => {
		options.clearReaperTimer();
		try {
			await options.stopAllZones();
		} finally {
			await options.closeControllerServer();
		}
		return { ok: true } as const;
	};
}
