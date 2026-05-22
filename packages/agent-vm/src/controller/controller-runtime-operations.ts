import { timingSafeEqual } from 'node:crypto';

import type { SecretRef, SecretResolver } from '@agent-vm/secret-management';

import type { SystemConfig } from '../config/system-config.js';
import {
	buildControllerStatus,
	buildControllerZoneStatus,
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
import type { OpenClawZoneRuntime } from './zone-runtimes/zone-runtime-types.js';

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
		readonly zoneId: string;
	}>;
	readonly getZoneStatus: (targetZoneId: string) => Promise<unknown>;
	readonly refreshZoneCredentials: (targetZoneId: string) => Promise<{
		readonly ok: true;
		readonly zoneId: string;
	}>;
	readonly upgradeZone: (targetZoneId: string) => Promise<unknown>;
}

export function createControllerRuntimeOperations(options: {
	readonly getActiveLeases: () => readonly { readonly zoneId: string }[];
	readonly getOpenClawRuntime: (
		zoneId: string,
	) => Pick<
		OpenClawZoneRuntime,
		'destroy' | 'enableSsh' | 'exec' | 'getHealth' | 'getLogs' | 'refreshCredentials' | 'upgrade'
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
	readonly secretResolver: SecretResolver;
	readonly systemConfig: SystemConfig;
}): ControllerRuntimeOperations {
	const buildRuntimeStatus = (): ControllerRuntimeStatus => {
		const zones = options.getRuntimeStatusByZone();
		return {
			activeLeases: options.getActiveLeases(),
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
			const sshAccess = await options.getOpenClawRuntime(targetZoneId).enableSsh();
			return {
				...sshAccess,
				secretEnvEnabled: shouldEnableSshSecretEnv({
					policy: zone.gateway.ssh?.secretEnv ?? 'explicit',
					request: enableOptions.secretEnv,
				}),
			};
		},
		execInZone: async (targetZoneId, command, execOptions) => {
			const zone = findZone(targetZoneId);
			await verifyZoneAdminAccess({
				providedToken: execOptions.adminToken,
				secretResolver: options.secretResolver,
				zone,
			});
			return await options.getOpenClawRuntime(targetZoneId).exec(command);
		},
		getStatus: async () => buildControllerStatus(options.systemConfig, buildRuntimeStatus()),
		getZoneHealth: async (targetZoneId) =>
			await options.getOpenClawRuntime(targetZoneId).getHealth(),
		getZoneLogs: async (targetZoneId) => await options.getOpenClawRuntime(targetZoneId).getLogs(),
		getZoneStatus: async (targetZoneId) => {
			findZone(targetZoneId);
			return buildControllerZoneStatus(options.systemConfig, targetZoneId, buildRuntimeStatus());
		},
		refreshZoneCredentials: async (targetZoneId) =>
			await options.getOpenClawRuntime(targetZoneId).refreshCredentials(),
		upgradeZone: async (targetZoneId) => await options.getOpenClawRuntime(targetZoneId).upgrade(),
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

export function shouldEnableSshSecretEnv(options: {
	readonly policy: 'explicit' | 'never';
	readonly request: 'default' | 'with-secrets';
}): boolean {
	if (options.policy === 'never') {
		return false;
	}
	return options.request === 'with-secrets';
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
	readonly getLeases: () => readonly { readonly id: string }[];
	readonly releaseLease: (leaseId: string, options?: { readonly force?: boolean }) => Promise<void>;
	readonly stopAllZones: () => Promise<void>;
}): () => Promise<{ readonly ok: true }> {
	return async (): Promise<{ readonly ok: true }> => {
		options.clearReaperTimer();
		for (const lease of options.getLeases()) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- sequential release avoids TCP slot races
			await options.releaseLease(lease.id, { force: true });
		}
		try {
			await options.stopAllZones();
		} finally {
			await options.closeControllerServer();
		}
		return { ok: true } as const;
	};
}
