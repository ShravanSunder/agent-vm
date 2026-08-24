import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import { TEST_SSH_SERVER_HOST_KEY } from '../testing/managed-vm-test-helpers.js';
import { createControllerRuntimeOperations } from './controller-runtime-operations.js';
import type { ControllerZoneAdminAuthError } from './zone-runtimes/zone-runtime-errors.js';
import { ControllerZoneNotFoundError } from './zone-runtimes/zone-runtime-errors.js';
import type { ManagedGatewayZoneRuntime } from './zone-runtimes/zone-runtime-types.js';

const controllerRuntimeOperationsTestRoot = path.join(
	tmpdir(),
	`agent-vm-controller-runtime-operations-test-${process.pid}`,
);

const systemConfig = {
	schemaVersion: 2,
	storageRootDir: controllerRuntimeOperationsTestRoot,
	cacheDir: path.join(controllerRuntimeOperationsTestRoot, 'cache'),
	controllerStateDir: path.join(controllerRuntimeOperationsTestRoot, 'controller-state'),
	controllerRuntimeDir: path.join(controllerRuntimeOperationsTestRoot, 'controller-runtime'),
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
				type: 'hermes',
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
				type: 'hermes',
				profileSecretProjectionsByAgent: { main: {} },
				profilesByAgent: { main: 'main' },
				imageProfile: 'openclaw',
				memory: '2G',
				cpus: 2,
				port: 18791,
				config: './config/shravan/openclaw.json',
				stateDir: path.join(controllerRuntimeOperationsTestRoot, 'shravan', 'state'),
				zoneFilesDir: path.join(controllerRuntimeOperationsTestRoot, 'shravan', 'zone-files'),
				zoneRuntimeDir: path.join(controllerRuntimeOperationsTestRoot, 'shravan', 'runtime'),
			},
			secrets: {
				OPENCLAW_GATEWAY_TOKEN: {
					source: 'environment',
					envVar: 'OPENCLAW_GATEWAY_TOKEN',
					injection: 'env',
					audience: 'gateway',
				},
			},
			egressHosts: ['api.openai.com'].map((host) => ({ host, audience: 'gateway' as const })),
			defaultToolVmProfile: 'standard',
			agentToolVmProfiles: {},
		},
		{
			id: 'alevtina',
			adminAccess: { mode: 'none' },
			gateway: {
				type: 'hermes',
				profileSecretProjectionsByAgent: { main: {} },
				profilesByAgent: { main: 'main' },
				imageProfile: 'openclaw',
				memory: '2G',
				cpus: 2,
				port: 18792,
				config: './config/alevtina/openclaw.json',
				stateDir: path.join(controllerRuntimeOperationsTestRoot, 'alevtina', 'state'),
				zoneFilesDir: path.join(controllerRuntimeOperationsTestRoot, 'alevtina', 'zone-files'),
				zoneRuntimeDir: path.join(controllerRuntimeOperationsTestRoot, 'alevtina', 'runtime'),
			},
			secrets: {
				OPENCLAW_GATEWAY_TOKEN: {
					source: 'environment',
					envVar: 'OPENCLAW_GATEWAY_TOKEN',
					injection: 'env',
					audience: 'gateway',
				},
			},
			egressHosts: ['api.openai.com'].map((host) => ({ host, audience: 'gateway' as const })),
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

afterEach(async () => {
	await rm(controllerRuntimeOperationsTestRoot, { force: true, recursive: true });
});

function isPathInsideDirectory(candidatePath: string, directoryPath: string): boolean {
	const relativePath = path.relative(path.resolve(directoryPath), path.resolve(candidatePath));
	return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function requireBaseZone(): (typeof systemConfig.zones)[number] {
	const zone = systemConfig.zones[0];
	if (!zone) {
		throw new Error('Expected test system config to include a zone.');
	}
	return zone;
}

const baseZone = requireBaseZone();

function createHermesSystemConfig(): SystemConfig {
	return {
		...systemConfig,
		imageProfiles: {
			...systemConfig.imageProfiles,
			gateways: {
				...systemConfig.imageProfiles.gateways,
				hermes: { type: 'hermes', buildConfig: './vm-images/gateways/hermes/build-config.json' },
			},
		},
		zones: [
			{
				...baseZone,
				agents: [{ id: 'main' }],
				egressHosts: baseZone.egressHosts,
				gateway: {
					config: './config/hermes/config.yaml',
					cpus: 2,
					imageProfile: 'hermes',
					memory: '2G',
					port: 18_793,
					profilesByAgent: { main: 'main' },
					profileSecretProjectionsByAgent: {
						main: {
							API_SERVER_KEY: 'API_SERVER_KEY_MAIN',
							DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN',
						},
					},
					stateDir: path.join(controllerRuntimeOperationsTestRoot, 'hermes-zone', 'state'),
					type: 'hermes',
					zoneFilesDir: path.join(controllerRuntimeOperationsTestRoot, 'hermes-zone', 'zone-files'),
					zoneRuntimeDir: path.join(controllerRuntimeOperationsTestRoot, 'hermes-zone', 'runtime'),
				},
				id: 'hermes-zone',
				secrets: {
					API_SERVER_KEY_MAIN: {
						audience: 'gateway',
						envVar: 'API_SERVER_KEY_MAIN',
						injection: 'env',
						source: 'environment',
					},
				},
			},
		],
	};
}

describe('controller runtime operations test fixture paths', () => {
	it('keeps generated runtime and state paths outside the repository checkout', () => {
		const generatedPaths = [
			systemConfig.cacheDir,
			systemConfig.controllerRuntimeDir,
			...systemConfig.zones.flatMap((zone) => [
				zone.gateway.stateDir,
				...(zone.gateway.type === 'hermes' ? [zone.gateway.zoneFilesDir] : []),
			]),
		];

		expect(
			generatedPaths.filter((generatedPath) =>
				isPathInsideDirectory(path.resolve(generatedPath), process.cwd()),
			),
		).toEqual([]);
	});
});

describe('createControllerRuntimeOperations', () => {
	it('dispatches OpenClaw operations to the requested zone runtime', async () => {
		const shravanRuntime = {
			destroy: vi.fn(async (purged: boolean) => ({ ok: true as const, purged, zoneId: 'shravan' })),
			enableSsh: vi.fn(async () => ({
				close: async () => {},
				serverHostKey: TEST_SSH_SERVER_HOST_KEY,
				command: 'ssh shravan',
				host: '127.0.0.1',
				identityFile: '/tmp/shravan-identity',
				port: 22,
				user: 'root',
			})),
			exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: 'shravan' })),
			getHealth: vi.fn(async () => ({
				ok: true,
				observation: 'http 200',
				path: '/readyz',
				zoneId: 'shravan',
			})),
			getServiceHealth: vi.fn(async () => ({
				ok: true,
				observation: 'http 200',
				path: '/health',
				zoneId: 'shravan',
			})),
			getLogs: vi.fn(async () => ({ output: 'shravan logs', zoneId: 'shravan' })),
			refreshCredentials: vi.fn(async () => ({ ok: true as const, zoneId: 'shravan' })),
			upgrade: vi.fn(async () => ({ ok: true as const, zoneId: 'shravan' })),
		} satisfies Pick<
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
		const alevtinaRuntime = {
			destroy: vi.fn(async (purged: boolean) => ({
				ok: true as const,
				purged,
				zoneId: 'alevtina',
			})),
			enableSsh: vi.fn(async () => ({
				close: async () => {},
				serverHostKey: TEST_SSH_SERVER_HOST_KEY,
				command: 'ssh alevtina',
				host: '127.0.0.1',
				identityFile: '/tmp/alevtina-identity',
				port: 22,
				user: 'root',
			})),
			exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: 'alevtina' })),
			getHealth: vi.fn(async () => ({
				ok: true,
				observation: 'http 200',
				path: '/readyz',
				zoneId: 'alevtina',
			})),
			getServiceHealth: vi.fn(async () => ({
				ok: true,
				observation: 'http 200',
				path: '/health',
				zoneId: 'alevtina',
			})),
			getLogs: vi.fn(async () => ({ output: 'alevtina logs', zoneId: 'alevtina' })),
			refreshCredentials: vi.fn(async () => ({ ok: true as const, zoneId: 'alevtina' })),
			upgrade: vi.fn(async () => ({ ok: true as const, zoneId: 'alevtina' })),
		} satisfies Pick<
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
		const operations = createControllerRuntimeOperations({
			destroyZoneRuntime: async (zoneId, purged) =>
				await (zoneId === 'shravan' ? shravanRuntime : alevtinaRuntime).destroy(purged),
			getActiveLeases: () => [],
			getManagedGatewayRuntime: (zoneId) =>
				zoneId === 'shravan' ? shravanRuntime : alevtinaRuntime,
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
		await expect(operations.execInZone('shravan', 'pwd', {})).resolves.toEqual({
			exitCode: 0,
			stderr: '',
			stdout: 'shravan',
		});
		await expect(operations.getZoneHealth('alevtina')).resolves.toEqual({
			ok: true,
			observation: 'http 200',
			path: '/readyz',
			zoneId: 'alevtina',
		});
		await expect(operations.getZoneServiceHealth('alevtina')).resolves.toEqual({
			ok: true,
			observation: 'http 200',
			path: '/health',
			zoneId: 'alevtina',
		});
		await expect(operations.destroyZone('alevtina', true)).resolves.toEqual({
			ok: true,
			purged: true,
			zoneId: 'alevtina',
		});

		expect(alevtinaRuntime.getLogs).toHaveBeenCalledTimes(1);
		expect(alevtinaRuntime.getHealth).toHaveBeenCalledTimes(1);
		expect(alevtinaRuntime.getServiceHealth).toHaveBeenCalledTimes(1);
		expect(shravanRuntime.exec).toHaveBeenCalledWith('pwd');
		expect(alevtinaRuntime.destroy).toHaveBeenCalledWith(true);
	});

	it('dispatches Hermes admin shell operations through the managed Gateway runtime', async () => {
		const hermesSystemConfig = createHermesSystemConfig();
		const hermesRuntime = {
			destroy: vi.fn(async (purged: boolean) => ({
				ok: true as const,
				purged,
				zoneId: 'hermes-zone',
			})),
			enableSsh: vi.fn(async () => ({
				close: async () => {},
				command: 'ssh hermes-zone',
				host: '127.0.0.1',
				identityFile: '/tmp/hermes-zone-identity',
				port: 22,
				serverHostKey: TEST_SSH_SERVER_HOST_KEY,
				user: 'root',
			})),
			exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: 'hermes-zone' })),
			getHealth: vi.fn(async () => ({
				ok: true,
				observation: 'http 200',
				zoneId: 'hermes-zone',
			})),
			getLogs: vi.fn(async () => ({ output: 'hermes logs', zoneId: 'hermes-zone' })),
			getServiceHealth: vi.fn(async () => ({
				ok: true,
				observation: 'http 200',
				zoneId: 'hermes-zone',
			})),
			refreshCredentials: vi.fn(async () => ({ ok: true as const, zoneId: 'hermes-zone' })),
			upgrade: vi.fn(async () => ({ ok: true as const, zoneId: 'hermes-zone' })),
		} satisfies Pick<
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
		const operations = createControllerRuntimeOperations({
			destroyZoneRuntime: async (_zoneId, purged) => await hermesRuntime.destroy(purged),
			getActiveLeases: () => [],
			getManagedGatewayRuntime: () => hermesRuntime,
			getRuntimeStatusByZone: () => ({
				'hermes-zone': { lifecycleState: 'running' },
			}),
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: hermesSystemConfig,
		});

		await expect(operations.execInZone('hermes-zone', 'pwd', {})).resolves.toEqual({
			exitCode: 0,
			stderr: '',
			stdout: 'hermes-zone',
		});
		await expect(operations.enableSshForZone('hermes-zone', {})).resolves.toMatchObject({
			command: 'ssh hermes-zone',
		});

		expect(hermesRuntime.exec).toHaveBeenCalledWith('pwd');
		expect(hermesRuntime.enableSsh).toHaveBeenCalledOnce();
	});

	it('throws the typed not-found error for unknown zone status', async () => {
		const runtime = {
			destroy: vi.fn(async (purged: boolean) => ({ ok: true as const, purged, zoneId: 'shravan' })),
			enableSsh: vi.fn(async () => ({
				close: async () => {},
				serverHostKey: TEST_SSH_SERVER_HOST_KEY,
				command: 'ssh shravan',
				host: '127.0.0.1',
				identityFile: '/tmp/shravan-identity',
				port: 22,
				user: 'root',
			})),
			exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: 'shravan' })),
			getHealth: vi.fn(async () => ({ ok: true, observation: 'http 200', zoneId: 'shravan' })),
			getServiceHealth: vi.fn(async () => ({
				ok: true,
				observation: 'http 200',
				zoneId: 'shravan',
			})),
			getLogs: vi.fn(async () => ({ output: 'shravan logs', zoneId: 'shravan' })),
			refreshCredentials: vi.fn(async () => ({ ok: true as const, zoneId: 'shravan' })),
			upgrade: vi.fn(async () => ({ ok: true as const, zoneId: 'shravan' })),
		} satisfies Pick<
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
		const operations = createControllerRuntimeOperations({
			destroyZoneRuntime: async (_zoneId, purged) => await runtime.destroy(purged),
			getActiveLeases: () => [],
			getManagedGatewayRuntime: () => runtime,
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
			close: async () => {},
			command: 'ssh shravan',
			host: '127.0.0.1',
			identityFile: '/tmp/shravan-identity',
			port: 22,
			serverHostKey: TEST_SSH_SERVER_HOST_KEY,
			user: 'root',
		}));
		const runtime = {
			destroy: vi.fn(async (purged: boolean) => ({ ok: true as const, purged, zoneId: 'shravan' })),
			enableSsh,
			exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: 'shravan' })),
			getHealth: vi.fn(async () => ({ ok: true, observation: 'http 200', zoneId: 'shravan' })),
			getServiceHealth: vi.fn(async () => ({
				ok: true,
				observation: 'http 200',
				zoneId: 'shravan',
			})),
			getLogs: vi.fn(async () => ({ output: 'shravan logs', zoneId: 'shravan' })),
			refreshCredentials: vi.fn(async () => ({ ok: true as const, zoneId: 'shravan' })),
			upgrade: vi.fn(async () => ({ ok: true as const, zoneId: 'shravan' })),
		} satisfies Pick<
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
		const resolveSecret = vi.fn(async () => 'expected-admin-token');
		const operations = createControllerRuntimeOperations({
			destroyZoneRuntime: async (_zoneId, purged) => await runtime.destroy(purged),
			getActiveLeases: () => [],
			getManagedGatewayRuntime: () => runtime,
			getRuntimeStatusByZone: () => ({}),
			secretResolver: {
				resolve: resolveSecret,
				resolveAll: async () => ({}),
			},
			systemConfig: {
				...systemConfig,
				zones: [
					{
						...baseZone,
						adminAccess: {
							mode: 'secret',
							secret: { source: 'config', value: 'expected-admin-token' },
						},
					},
				],
			},
		});

		await expect(operations.enableSshForZone('shravan', {})).rejects.toMatchObject({
			code: 'zone-admin-auth-required',
			httpStatus: 401,
		} satisfies Partial<ControllerZoneAdminAuthError>);
		await expect(
			operations.enableSshForZone('shravan', {
				adminToken: 'wrong-admin-token',
			}),
		).rejects.toMatchObject({
			code: 'zone-admin-auth-denied',
			httpStatus: 403,
		} satisfies Partial<ControllerZoneAdminAuthError>);
		await expect(
			operations.enableSshForZone('shravan', {
				adminToken: 'expected-admin-token',
			}),
		).resolves.toMatchObject({
			host: '127.0.0.1',
		});
		expect(enableSsh).toHaveBeenCalledTimes(1);
		expect(resolveSecret).toHaveBeenLastCalledWith({
			source: 'config',
			value: 'expected-admin-token',
		});
	});

	it('requires the configured zone admin token before executing gateway commands', async () => {
		const exec = vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: 'shravan' }));
		const runtime = {
			destroy: vi.fn(async (purged: boolean) => ({ ok: true as const, purged, zoneId: 'shravan' })),
			enableSsh: vi.fn(async () => ({
				close: async () => {},
				serverHostKey: TEST_SSH_SERVER_HOST_KEY,
				command: 'ssh shravan',
				host: '127.0.0.1',
				identityFile: '/tmp/shravan-identity',
				port: 22,
				user: 'root',
			})),
			exec,
			getHealth: vi.fn(async () => ({ ok: true, observation: 'http 200', zoneId: 'shravan' })),
			getServiceHealth: vi.fn(async () => ({
				ok: true,
				observation: 'http 200',
				zoneId: 'shravan',
			})),
			getLogs: vi.fn(async () => ({ output: 'shravan logs', zoneId: 'shravan' })),
			refreshCredentials: vi.fn(async () => ({ ok: true as const, zoneId: 'shravan' })),
			upgrade: vi.fn(async () => ({ ok: true as const, zoneId: 'shravan' })),
		} satisfies Pick<
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
		const operations = createControllerRuntimeOperations({
			destroyZoneRuntime: async (_zoneId, purged) => await runtime.destroy(purged),
			getActiveLeases: () => [],
			getManagedGatewayRuntime: () => runtime,
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

		await expect(operations.execInZone('shravan', 'pwd', {})).rejects.toMatchObject({
			code: 'zone-admin-auth-required',
			httpStatus: 401,
		} satisfies Partial<ControllerZoneAdminAuthError>);
		await expect(
			operations.execInZone('shravan', 'pwd', { adminToken: 'wrong-admin-token' }),
		).rejects.toMatchObject({
			code: 'zone-admin-auth-denied',
			httpStatus: 403,
		} satisfies Partial<ControllerZoneAdminAuthError>);
		await expect(
			operations.execInZone('shravan', 'pwd', { adminToken: 'expected-admin-token' }),
		).resolves.toEqual({
			exitCode: 0,
			stderr: '',
			stdout: 'shravan',
		});
		expect(exec).toHaveBeenCalledTimes(1);
	});
});
