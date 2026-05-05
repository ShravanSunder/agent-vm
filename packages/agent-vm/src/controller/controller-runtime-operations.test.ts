import { describe, expect, it, vi } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import {
	createControllerRuntimeOperations,
	shouldEnableSshSecretEnv,
} from './controller-runtime-operations.js';
import type { ControllerZoneAdminAuthError } from './zone-runtimes/zone-runtime-errors.js';
import { ControllerZoneNotFoundError } from './zone-runtimes/zone-runtime-errors.js';
import type { OpenClawZoneRuntime } from './zone-runtimes/zone-runtime-types.js';

const systemConfig = {
	cacheDir: './cache',
	runtimeDir: './runtime',
	host: {
		controllerPort: 18800,
		projectNamespace: 'claw-tests-a1b2c3d4',
		secretsProvider: {
			type: '1password',
			tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
		},
	},
	imageProfiles: {
		gateways: {
			openclaw: {
				type: 'openclaw',
				buildConfig: './vm-images/gateways/openclaw/build-config.json',
			},
			worker: { type: 'worker', buildConfig: './vm-images/gateways/worker/build-config.json' },
		},
		toolVms: {
			default: { type: 'toolVm', buildConfig: './vm-images/tool-vms/default/build-config.json' },
		},
	},
	zones: [
		{
			id: 'shravan',
			adminAccess: { mode: 'none' },
			gateway: {
				type: 'openclaw',
				imageProfile: 'openclaw',
				memory: '2G',
				cpus: 2,
				port: 18791,
				config: './config/shravan/openclaw.json',
				stateDir: './state/shravan',
				ssh: { secretEnv: 'explicit' },
				zoneFilesDir: './zone-files/shravan',
			},
			secrets: {},
			allowedHosts: ['api.openai.com'],
			websocketBypass: [],
			defaultToolVmProfile: 'standard',
			agentToolVmProfiles: {},
		},
		{
			id: 'alevtina',
			adminAccess: { mode: 'none' },
			gateway: {
				type: 'openclaw',
				imageProfile: 'openclaw',
				memory: '2G',
				cpus: 2,
				port: 18792,
				config: './config/alevtina/openclaw.json',
				stateDir: './state/alevtina',
				ssh: { secretEnv: 'explicit' },
				zoneFilesDir: './zone-files/alevtina',
			},
			secrets: {},
			allowedHosts: ['api.openai.com'],
			websocketBypass: [],
			defaultToolVmProfile: 'standard',
			agentToolVmProfiles: {},
		},
	],
	toolVmProfiles: {
		standard: {
			memory: '1G',
			cpus: 1,
			imageProfile: 'default',
		},
	},
	tcpPool: {
		basePort: 19000,
		size: 5,
	},
} satisfies SystemConfig;

const baseZone = systemConfig.zones[0];
if (!baseZone) {
	throw new Error('Expected test system config to include a zone.');
}

describe('createControllerRuntimeOperations', () => {
	it('dispatches OpenClaw operations to the requested zone runtime', async () => {
		const shravanRuntime = {
			destroy: vi.fn(async (purged: boolean) => ({ ok: true as const, purged, zoneId: 'shravan' })),
			enableSsh: vi.fn(async () => ({ command: 'ssh shravan', host: '127.0.0.1', port: 22 })),
			exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: 'shravan' })),
			getHealth: vi.fn(async () => ({
				ok: true,
				observation: 'http 200',
				zoneId: 'shravan',
			})),
			getLogs: vi.fn(async () => ({ output: 'shravan logs', zoneId: 'shravan' })),
			refreshCredentials: vi.fn(async () => ({ ok: true as const, zoneId: 'shravan' })),
			upgrade: vi.fn(async () => ({ ok: true as const, zoneId: 'shravan' })),
		} satisfies Pick<
			OpenClawZoneRuntime,
			'destroy' | 'enableSsh' | 'exec' | 'getHealth' | 'getLogs' | 'refreshCredentials' | 'upgrade'
		>;
		const alevtinaRuntime = {
			destroy: vi.fn(async (purged: boolean) => ({
				ok: true as const,
				purged,
				zoneId: 'alevtina',
			})),
			enableSsh: vi.fn(async () => ({
				command: 'ssh alevtina',
				host: '127.0.0.1',
				port: 22,
			})),
			exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: 'alevtina' })),
			getHealth: vi.fn(async () => ({
				ok: true,
				observation: 'http 200',
				zoneId: 'alevtina',
			})),
			getLogs: vi.fn(async () => ({ output: 'alevtina logs', zoneId: 'alevtina' })),
			refreshCredentials: vi.fn(async () => ({ ok: true as const, zoneId: 'alevtina' })),
			upgrade: vi.fn(async () => ({ ok: true as const, zoneId: 'alevtina' })),
		} satisfies Pick<
			OpenClawZoneRuntime,
			'destroy' | 'enableSsh' | 'exec' | 'getHealth' | 'getLogs' | 'refreshCredentials' | 'upgrade'
		>;
		const operations = createControllerRuntimeOperations({
			destroyZoneRuntime: async (zoneId, purged) =>
				await (zoneId === 'shravan' ? shravanRuntime : alevtinaRuntime).destroy(purged),
			getActiveLeases: () => [],
			getOpenClawRuntime: (zoneId) => (zoneId === 'shravan' ? shravanRuntime : alevtinaRuntime),
			getRuntimeStatusByZone: () => ({
				alevtina: { lifecycleState: 'running' },
				shravan: { lifecycleState: 'running' },
			}),
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig,
		});

		await expect(operations.getZoneLogs('alevtina')).resolves.toEqual({
			output: 'alevtina logs',
			zoneId: 'alevtina',
		});
		await expect(operations.execInZone('shravan', 'pwd')).resolves.toEqual({
			exitCode: 0,
			stderr: '',
			stdout: 'shravan',
		});
		await expect(operations.getZoneHealth('alevtina')).resolves.toEqual({
			ok: true,
			observation: 'http 200',
			zoneId: 'alevtina',
		});
		await expect(operations.destroyZone('alevtina', true)).resolves.toEqual({
			ok: true,
			purged: true,
			zoneId: 'alevtina',
		});

		expect(alevtinaRuntime.getLogs).toHaveBeenCalledTimes(1);
		expect(alevtinaRuntime.getHealth).toHaveBeenCalledTimes(1);
		expect(shravanRuntime.exec).toHaveBeenCalledWith('pwd');
		expect(alevtinaRuntime.destroy).toHaveBeenCalledWith(true);
	});

	it('throws the typed not-found error for unknown zone status', async () => {
		const runtime = {
			destroy: vi.fn(async (purged: boolean) => ({ ok: true as const, purged, zoneId: 'shravan' })),
			enableSsh: vi.fn(async () => ({ command: 'ssh shravan', host: '127.0.0.1', port: 22 })),
			exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: 'shravan' })),
			getHealth: vi.fn(async () => ({ ok: true, observation: 'http 200', zoneId: 'shravan' })),
			getLogs: vi.fn(async () => ({ output: 'shravan logs', zoneId: 'shravan' })),
			refreshCredentials: vi.fn(async () => ({ ok: true as const, zoneId: 'shravan' })),
			upgrade: vi.fn(async () => ({ ok: true as const, zoneId: 'shravan' })),
		} satisfies Pick<
			OpenClawZoneRuntime,
			'destroy' | 'enableSsh' | 'exec' | 'getHealth' | 'getLogs' | 'refreshCredentials' | 'upgrade'
		>;
		const operations = createControllerRuntimeOperations({
			destroyZoneRuntime: async (_zoneId, purged) => await runtime.destroy(purged),
			getActiveLeases: () => [],
			getOpenClawRuntime: () => runtime,
			getRuntimeStatusByZone: () => ({}),
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig,
		});

		await expect(operations.getZoneStatus('missing-zone')).rejects.toBeInstanceOf(
			ControllerZoneNotFoundError,
		);
	});

	it('requires the configured zone admin token before enabling SSH', async () => {
		const enableSsh = vi.fn(async () => ({
			command: 'ssh shravan',
			host: '127.0.0.1',
			port: 22,
		}));
		const runtime = {
			destroy: vi.fn(async (purged: boolean) => ({ ok: true as const, purged, zoneId: 'shravan' })),
			enableSsh,
			exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: 'shravan' })),
			getHealth: vi.fn(async () => ({ ok: true, observation: 'http 200', zoneId: 'shravan' })),
			getLogs: vi.fn(async () => ({ output: 'shravan logs', zoneId: 'shravan' })),
			refreshCredentials: vi.fn(async () => ({ ok: true as const, zoneId: 'shravan' })),
			upgrade: vi.fn(async () => ({ ok: true as const, zoneId: 'shravan' })),
		} satisfies Pick<
			OpenClawZoneRuntime,
			'destroy' | 'enableSsh' | 'exec' | 'getHealth' | 'getLogs' | 'refreshCredentials' | 'upgrade'
		>;
		const operations = createControllerRuntimeOperations({
			destroyZoneRuntime: async (_zoneId, purged) => await runtime.destroy(purged),
			getActiveLeases: () => [],
			getOpenClawRuntime: () => runtime,
			getRuntimeStatusByZone: () => ({}),
			secretResolver: {
				resolve: async () => 'expected-admin-token',
				resolveAll: async () => ({}),
			},
			systemConfig: {
				...systemConfig,
				zones: [
					{
						...baseZone,
						adminAccess: {
							mode: 'secret',
							secret: { source: 'environment', envVar: 'SUNFAM_SSH_ACCESS_TOKEN' },
						},
					},
				],
			},
		});

		await expect(
			operations.enableSshForZone('shravan', { secretEnv: 'default' }),
		).rejects.toMatchObject({
			code: 'zone-admin-auth-required',
			httpStatus: 401,
		} satisfies Partial<ControllerZoneAdminAuthError>);
		await expect(
			operations.enableSshForZone('shravan', {
				adminToken: 'wrong-admin-token',
				secretEnv: 'default',
			}),
		).rejects.toMatchObject({
			code: 'zone-admin-auth-denied',
			httpStatus: 403,
		} satisfies Partial<ControllerZoneAdminAuthError>);
		await expect(
			operations.enableSshForZone('shravan', {
				adminToken: 'expected-admin-token',
				secretEnv: 'with-secrets',
			}),
		).resolves.toMatchObject({
			host: '127.0.0.1',
			secretEnvEnabled: true,
		});
		expect(enableSsh).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ expected: false, policy: 'never', request: 'default' },
		{ expected: false, policy: 'never', request: 'with-secrets' },
		{ expected: false, policy: 'explicit', request: 'default' },
		{ expected: true, policy: 'explicit', request: 'with-secrets' },
		{ expected: true, policy: 'always', request: 'default' },
		{ expected: true, policy: 'always', request: 'with-secrets' },
	] as const)(
		'resolves ssh secret env policy $policy with request $request',
		({ expected, policy, request }) => {
			expect(shouldEnableSshSecretEnv({ policy, request })).toBe(expected);
		},
	);
});
