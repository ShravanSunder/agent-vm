import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ManagedImageRelease } from '../build/managed-image-dockerfile.js';
import {
	createLoadedSystemConfig,
	type SystemConfig,
	type SystemConfigInput,
} from '../config/system-config.js';
import {
	collectManagedAgentRootStorageChecks,
	collectManagedImagePackageOverrideDoctorChecks,
	collectVmHostSystemDoctorCheck,
	runControllerDoctor,
} from './doctor.js';

describe('collectManagedAgentRootStorageChecks', () => {
	const temporaryRoots: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temporaryRoots.splice(0).map(async (temporaryRoot) => {
				await rm(temporaryRoot, { force: true, recursive: true });
			}),
		);
	});

	it('accepts both absent roots before controller materialization', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'doctor-agent-roots-'));
		temporaryRoots.push(temporaryDirectoryPath);
		const firstZone = systemConfig.zones[0];
		if (firstZone === undefined || firstZone.gateway.type !== 'openclaw') {
			throw new Error('Test fixture must include an OpenClaw zone.');
		}

		const checks = await collectManagedAgentRootStorageChecks({
			...systemConfig,
			zones: [
				{
					...firstZone,
					gateway: {
						...firstZone.gateway,
						zoneFilesDir: path.join(temporaryDirectoryPath, 'zone-files'),
					},
				},
			],
		});

		expect(checks).toEqual([
			expect.objectContaining({ hint: 'pending controller materialization', ok: true }),
		]);
	});

	it('rejects an unsafe managed agent workspace root', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'doctor-agent-roots-'));
		temporaryRoots.push(temporaryDirectoryPath);
		const zoneFilesDir = path.join(temporaryDirectoryPath, 'zone-files');
		const firstZone = systemConfig.zones[0];
		if (firstZone === undefined || firstZone.gateway.type !== 'openclaw') {
			throw new Error('Test fixture must include an OpenClaw zone.');
		}
		await mkdir(path.join(zoneFilesDir, 'agents'), { recursive: true });
		await writeFile(path.join(zoneFilesDir, 'agents', 'shravan'), 'not a directory');

		const checks = await collectManagedAgentRootStorageChecks({
			...systemConfig,
			zones: [
				{
					...firstZone,
					gateway: { ...firstZone.gateway, zoneFilesDir },
				},
			],
		});

		expect(checks).toEqual([
			expect.objectContaining({
				hint: expect.stringContaining('workspace=unsafe'),
				ok: false,
			}),
		]);
	});
});

const systemConfig = {
	schemaVersion: 2,
	storageRootDir: './storage',
	cacheDir: './cache',
	controllerStateDir: '/controller-state-test',
	controllerRuntimeDir: './runtime',
	host: {
		controllerPort: 18800,
		projectNamespace: 'claw-tests-a1b2c3d4',
		secretsProvider: {
			type: '1password',
			tokenSource: {
				type: 'env',
				envVar: 'OP_SERVICE_ACCOUNT_TOKEN',
			},
		},
	},
	imageProfiles: {
		gateways: {
			openclaw: {
				type: 'openclaw',
				buildConfig: './vm-images/gateways/openclaw/build-config.json',
			},
			worker: {
				type: 'worker',
				buildConfig: './vm-images/gateways/worker/build-config.json',
			},
		},
		toolVms: {
			default: {
				type: 'toolVm',
				buildConfig: './vm-images/tool-vms/default/build-config.json',
			},
		},
	},
	zones: [
		{
			id: 'shravan',
			agents: [{ id: 'shravan' }],
			gateway: {
				type: 'openclaw',
				controlAuth: {
					mode: 'token',
					secret: 'OPENCLAW_GATEWAY_TOKEN',
				},
				imageProfile: 'openclaw',
				memory: '2G',
				cpus: 2,
				port: 18791,
				config: './config/shravan/openclaw.json',
				stateDir: './state/shravan',
				zoneFilesDir: './zone-files/shravan',
				zoneRuntimeDir: './runtime/shravan',
				authProfilesByAgent: {
					shravan: { source: 'environment', envVar: 'SHRAVAN_AUTH_PROFILES' },
				},
			},
			secrets: {
				OPENCLAW_GATEWAY_TOKEN: {
					source: 'environment',
					envVar: 'OPENCLAW_GATEWAY_TOKEN',
					injection: 'env',
					audience: 'gateway',
				},
			},
			egressHosts: ['api.anthropic.com'].map((host) => ({ host, audience: 'gateway' as const })),
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

const allBinaries = new Set([
	'qemu-system-aarch64',
	'qemu-system-x86_64',
	'qemu-img',
	'mke2fs',
	'debugfs',
	'cpio',
	'lz4',
	'op',
	'openclaw',
	'security',
]);

function createManagedImageReleaseFixture(): ManagedImageRelease {
	return {
		baseImages: {
			'openclaw-gateway': {
				packageOverrides: {
					npm: ['@openai/codex@0.139.0'],
					openclaw: ['openclaw@2026.6.8', '@openclaw/codex@2026.6.8'],
					pnpm: { undici: '8.5.0' },
				},
				repository: 'ghcr.io/shravansunder/agent-vm-managed-openclaw-gateway-base',
				tag: '2026.05.27.1',
			},
			'worker-gateway': {
				packageOverrides: {
					npm: ['@openai/codex@0.139.0'],
					openclaw: [],
					pnpm: {},
				},
				repository: 'ghcr.io/shravansunder/agent-vm-managed-worker-gateway-base',
				tag: '2026.05.27.1',
			},
			'tool-vm': {
				packageOverrides: {
					npm: [],
					openclaw: [],
					pnpm: {},
				},
				repository: 'ghcr.io/shravansunder/agent-vm-managed-tool-vm-base',
				tag: '2026.05.27.1',
			},
		},
	};
}

interface RuntimePathOverlapCase {
	readonly cacheDir?: string;
	readonly controllerRuntimeDir?: string;
	readonly expectedHint: string;
	readonly stateDir?: string;
	readonly zoneFilesDir?: string;
}

function createSystemConfigInputFromResolvedFixture(config: SystemConfig): SystemConfigInput {
	const {
		cacheDir: _cacheDir,
		controllerRuntimeDir: _controllerRuntimeDir,
		controllerStateDir: _controllerStateDir,
		zones,
		...configInput
	} = config;
	return {
		...configInput,
		zones: zones.map((zone) => ({
			...zone,
			gateway: stripResolvedGatewayStorage(zone.gateway),
		})),
	};
}

function stripResolvedGatewayStorage(
	gateway: SystemConfig['zones'][number]['gateway'],
): SystemConfigInput['zones'][number]['gateway'] {
	if (gateway.type === 'worker') {
		const { stateDir: _stateDir, zoneRuntimeDir: _zoneRuntimeDir, ...gatewayInput } = gateway;
		return gatewayInput;
	}
	const {
		stateDir: _stateDir,
		zoneFilesDir: _zoneFilesDir,
		zoneRuntimeDir: _zoneRuntimeDir,
		...gatewayInput
	} = gateway;
	return gatewayInput;
}

function createWorkerOnlySystemConfig(): SystemConfig {
	return {
		...systemConfig,
		imageProfiles: {
			...systemConfig.imageProfiles,
			gateways: {
				worker: systemConfig.imageProfiles.gateways.worker,
			},
		},
		zones: [
			{
				id: 'worker',
				gateway: {
					type: 'worker',
					imageProfile: 'worker',
					memory: '2G',
					cpus: 2,
					port: 18791,
					config: './config/worker/worker.json',
					stateDir: './state/worker',
					zoneRuntimeDir: './runtime/worker',
				},
				secrets: {},
				egressHosts: ['api.openai.com'].map((host) => ({ host, audience: 'gateway' as const })),
			},
		],
	};
}

function createExternalObservabilitySystemConfig(): SystemConfig {
	return {
		...systemConfig,
		host: {
			...systemConfig.host,
			observability: {
				enabled: true,
				stack: {
					mode: 'external',
					scrubbing: { responsibility: 'external-collector' },
				},
				mode: 'collector',
				bindAddress: '127.0.0.1',
				prepareOnBuild: true,
				waitOnBuild: true,
				startupCheckTimeoutMs: 500,
				ports: {
					collectorGrpc: 4317,
					collectorHttp: 4318,
					collectorHealth: 13_133,
					metrics: 8428,
					logs: 9428,
					traces: 10_428,
				},
				controllerStartPolicy: 'degraded',
			},
		},
	};
}

function createManagedObservabilitySystemConfig(): SystemConfig {
	return {
		...systemConfig,
		host: {
			...systemConfig.host,
			observability: {
				enabled: true,
				stack: {
					mode: 'managed',
					scrubbing: { responsibility: 'agent-vm-managed-collector' },
				},
				runner: 'docker-compose',
				mode: 'collector',
				dataDir: './observability',
				bindAddress: '127.0.0.1',
				prepareOnBuild: true,
				waitOnBuild: true,
				startupCheckTimeoutMs: 500,
				ports: {
					collectorGrpc: 4317,
					collectorHttp: 4318,
					collectorHealth: 13_133,
					metrics: 8428,
					logs: 9428,
					traces: 10_428,
				},
				controllerStartPolicy: 'degraded',
				retention: {
					metrics: { period: '30d', minFreeDiskSpaceBytes: '5GiB' },
					logs: { period: '14d', maxDiskSpaceUsageBytes: '50GiB' },
					traces: { period: '7d', maxDiskSpaceUsageBytes: '20GiB' },
				},
			},
		},
	};
}

describe('runControllerDoctor', () => {
	it('reports deterministic failed legacy-controller-record checks for every affected zone', async () => {
		const firstZone = systemConfig.zones[0];
		if (!firstZone || firstZone.gateway.type !== 'openclaw') {
			throw new Error('Expected an OpenClaw test zone.');
		}
		const secondStateDirectory = '/state/sun';
		const firstStateDirectory = path.resolve(firstZone.gateway.stateDir);
		const scanGatewayStateAuthorityEvidence = vi.fn(
			async ({ gatewayStateDirectoryPath }: { readonly gatewayStateDirectoryPath: string }) =>
				gatewayStateDirectoryPath === firstStateDirectory
					? [
							{
								absolutePath: `${gatewayStateDirectoryPath}/tool-leases`,
								family: 'tool-leases' as const,
								kind: 'directory' as const,
							},
						]
					: [
							{
								absolutePath: `${gatewayStateDirectoryPath}/gateway-runtime.json`,
								family: 'gateway-runtime' as const,
								kind: 'symbolic-link' as const,
							},
						],
		);
		const result = await runControllerDoctor({
			availableBinaries: allBinaries,
			diskFreeBytes: 50 * 1024 * 1024 * 1024,
			env: { OP_SERVICE_ACCOUNT_TOKEN: 'token' },
			occupiedPorts: new Set<number>(),
			nodeVersion: 'v25.9.0',
			scanGatewayStateAuthorityEvidence,
			totalMemoryBytes: 16 * 1024 * 1024 * 1024,
			systemConfig: {
				...systemConfig,
				zones: [
					firstZone,
					{
						...firstZone,
						gateway: {
							...firstZone.gateway,
							port: firstZone.gateway.port + 1,
							stateDir: secondStateDirectory,
							zoneFilesDir: '/zone-files/sun',
						},
						id: 'sun',
					},
				],
			},
		});

		expect(scanGatewayStateAuthorityEvidence).toHaveBeenCalledTimes(2);
		expect(result.ok).toBe(false);
		expect(result.checks).toEqual(
			expect.arrayContaining([
				{
					name: 'legacy-controller-record-evidence-shravan-0',
					ok: false,
					hint: `family=tool-leases kind=directory path=${firstStateDirectory}/tool-leases; move controller-owned records to controllerStateDir and remove legacy Gateway-state evidence`,
				},
				{
					name: 'legacy-controller-record-evidence-sun-0',
					ok: false,
					hint: `family=gateway-runtime kind=symbolic-link path=${secondStateDirectory}/gateway-runtime.json; move controller-owned records to controllerStateDir and remove legacy Gateway-state evidence`,
				},
			]),
		);
	});

	it('reports one green legacy-controller-record check when every zone is clean', async () => {
		const result = await runControllerDoctor({
			availableBinaries: allBinaries,
			diskFreeBytes: 50 * 1024 * 1024 * 1024,
			env: { OP_SERVICE_ACCOUNT_TOKEN: 'token' },
			nodeVersion: 'v25.9.0',
			scanGatewayStateAuthorityEvidence: async () => [],
			systemConfig,
		});

		expect(result.checks).toContainEqual({
			name: 'legacy-controller-record-evidence',
			ok: true,
			hint: 'No legacy controller records exist under Gateway state directories.',
		});
	});
	it('reports all checks passing when environment is complete', async () => {
		const result = await runControllerDoctor({
			availableBinaries: allBinaries,
			diskFreeBytes: 50 * 1024 * 1024 * 1024,
			env: { OP_SERVICE_ACCOUNT_TOKEN: 'token' },
			occupiedPorts: new Set<number>(),
			nodeVersion: 'v25.9.0',
			requiredZigVersion: '0.15.2',
			totalMemoryBytes: 16 * 1024 * 1024 * 1024,
			zigVersion: '0.15.2',
			systemConfig: createExternalObservabilitySystemConfig(),
		});

		expect(result.ok).toBe(true);
		expect(result.checks.every((check) => check.ok)).toBe(true);
		expect(result.checks.find((check) => check.name === 'zig-version')).toMatchObject({
			ok: true,
			value: '0.15.2',
		});
		expect(result.checks.find((check) => check.name === 'qemu')?.ok).toBe(true);
		expect(result.checks.find((check) => check.name === 'qemu-img')?.ok).toBe(true);
		expect(result.checks.find((check) => check.name === 'mke2fs')?.ok).toBe(true);
		expect(result.checks.find((check) => check.name === 'debugfs')?.ok).toBe(true);
		expect(result.checks.find((check) => check.name === 'cpio')?.ok).toBe(true);
		expect(result.checks.find((check) => check.name === 'lz4')?.ok).toBe(true);
		expect(
			result.checks.find((check) => check.name === 'zone-default-tool-vm-profile-shravan'),
		).toMatchObject({
			ok: true,
			hint: 'standard',
		});
		expect(
			result.checks.find((check) => check.name === 'zone-agent-auth-profile-shravan-shravan'),
		).toMatchObject({
			ok: true,
			hint: 'configured',
		});
		expect(result.checks.find((check) => check.name === 'age')).toBeUndefined();
		expect(result.checks.find((check) => check.name === '1password-cli')).toBeUndefined();
		expect(result.checks.find((check) => check.name === 'observability-enabled')).toMatchObject({
			ok: true,
			hint: 'external',
		});
		expect(result.checks.find((check) => check.name === 'docker-cli')).toBeUndefined();
	});

	it('reports Tool VM mediated secret agent access', async () => {
		const baseConfig = createExternalObservabilitySystemConfig();
		const baseZone = baseConfig.zones[0];
		if (!baseZone) {
			throw new Error('Expected base doctor config to include an OpenClaw zone.');
		}
		const scopedSecretConfig = {
			...baseConfig,
			zones: [
				{
					...baseZone,
					agents: [{ id: 'shravan' }, { id: 'sun' }],
					egressHosts: [
						...baseZone.egressHosts,
						{ host: 'api.github.com', audience: 'tool-vm' as const },
						{ host: 'api.github.com', audience: 'gateway' as const },
						{ host: 'api.linear.app', audience: 'tool-vm' as const },
					],
					secrets: {
						...baseZone.secrets,
						GITHUB_TOKEN: {
							source: '1password',
							ref: 'op://agent-vm/example-sun-github/credential',
							injection: 'http-mediation',
							audience: 'both',
							hosts: ['api.github.com'],
							agentAccess: ['sun'],
						},
						LINEAR_API_KEY: {
							source: '1password',
							ref: 'op://agent-vm/shravan-linear/credential',
							injection: 'http-mediation',
							audience: 'tool-vm',
							hosts: ['api.linear.app'],
							agentAccess: 'all',
						},
					},
				},
			],
		} satisfies SystemConfig;

		const result = await runControllerDoctor({
			availableBinaries: allBinaries,
			diskFreeBytes: 50 * 1024 * 1024 * 1024,
			env: { OP_SERVICE_ACCOUNT_TOKEN: 'token' },
			occupiedPorts: new Set<number>(),
			nodeVersion: 'v25.9.0',
			requiredZigVersion: '0.15.2',
			totalMemoryBytes: 16 * 1024 * 1024 * 1024,
			zigVersion: '0.15.2',
			systemConfig: scopedSecretConfig,
		});

		expect(result.checks).toContainEqual({
			name: 'zone-agent-secret-access-shravan-GITHUB_TOKEN',
			ok: true,
			hint: 'tool-vm: sun; gateway: zone-wide',
		});
		expect(result.checks).toContainEqual({
			name: 'zone-agent-secret-access-shravan-LINEAR_API_KEY',
			ok: true,
			hint: 'tool-vm: all declared agents',
		});
	});

	it('recommends managed observability when host observability is omitted', async () => {
		const result = await runControllerDoctor({
			availableBinaries: allBinaries,
			diskFreeBytes: 50 * 1024 * 1024 * 1024,
			env: { OP_SERVICE_ACCOUNT_TOKEN: 'token' },
			occupiedPorts: new Set<number>(),
			nodeVersion: 'v25.9.0',
			requiredZigVersion: '0.15.2',
			totalMemoryBytes: 16 * 1024 * 1024 * 1024,
			zigVersion: '0.15.2',
			systemConfig,
		});

		expect(result.ok).toBe(true);
		expect(result.checks.find((check) => check.name === 'observability-enabled')).toMatchObject({
			ok: true,
			hint: expect.stringContaining('host.observability'),
		});
		expect(result.checks.find((check) => check.name === 'observability-enabled')?.hint).toContain(
			'managed',
		);
	});

	it('requires Docker only for managed observability stacks', async () => {
		const missingDockerResult = await runControllerDoctor({
			availableBinaries: allBinaries,
			diskFreeBytes: 50 * 1024 * 1024 * 1024,
			env: { OP_SERVICE_ACCOUNT_TOKEN: 'token' },
			occupiedPorts: new Set<number>(),
			nodeVersion: 'v25.9.0',
			requiredZigVersion: '0.15.2',
			totalMemoryBytes: 16 * 1024 * 1024 * 1024,
			zigVersion: '0.15.2',
			systemConfig: createManagedObservabilitySystemConfig(),
		});
		const readyDockerResult = await runControllerDoctor({
			availableBinaries: new Set([...allBinaries, 'docker']),
			diskFreeBytes: 50 * 1024 * 1024 * 1024,
			dockerDaemonReady: true,
			env: { OP_SERVICE_ACCOUNT_TOKEN: 'token' },
			occupiedPorts: new Set<number>(),
			nodeVersion: 'v25.9.0',
			requiredZigVersion: '0.15.2',
			totalMemoryBytes: 16 * 1024 * 1024 * 1024,
			zigVersion: '0.15.2',
			systemConfig: createManagedObservabilitySystemConfig(),
		});

		expect(missingDockerResult.ok).toBe(false);
		expect(missingDockerResult.checks.find((check) => check.name === 'docker-cli')).toMatchObject({
			ok: false,
		});
		expect(readyDockerResult.checks.find((check) => check.name === 'docker-cli')).toMatchObject({
			ok: true,
			hint: 'docker',
		});
	});

	it('checks Docker CLI and daemon when Docker-backed images are configured', async () => {
		const dockerBackedConfig = {
			...systemConfig,
			imageProfiles: {
				...systemConfig.imageProfiles,
				gateways: {
					openclaw: {
						...systemConfig.imageProfiles.gateways.openclaw,
						dockerfile: './vm-images/gateways/openclaw/Dockerfile',
					},
					worker: systemConfig.imageProfiles.gateways.worker,
				},
			},
		} satisfies SystemConfig;

		const missingDockerResult = await runControllerDoctor({
			availableBinaries: allBinaries,
			diskFreeBytes: 50 * 1024 * 1024 * 1024,
			env: { OP_SERVICE_ACCOUNT_TOKEN: 'token' },
			occupiedPorts: new Set<number>(),
			nodeVersion: 'v25.9.0',
			requiredZigVersion: '0.15.2',
			totalMemoryBytes: 16 * 1024 * 1024 * 1024,
			zigVersion: '0.15.2',
			systemConfig: dockerBackedConfig,
		});
		const readyDockerResult = await runControllerDoctor({
			availableBinaries: new Set([...allBinaries, 'docker']),
			diskFreeBytes: 50 * 1024 * 1024 * 1024,
			dockerDaemonReady: true,
			env: { OP_SERVICE_ACCOUNT_TOKEN: 'token' },
			occupiedPorts: new Set<number>(),
			nodeVersion: 'v25.9.0',
			requiredZigVersion: '0.15.2',
			totalMemoryBytes: 16 * 1024 * 1024 * 1024,
			zigVersion: '0.15.2',
			systemConfig: dockerBackedConfig,
		});

		expect(missingDockerResult.ok).toBe(false);
		expect(missingDockerResult.checks.find((check) => check.name === 'docker-cli')).toMatchObject({
			ok: false,
		});
		expect(
			missingDockerResult.checks.find((check) => check.name === 'docker-daemon'),
		).toMatchObject({
			ok: false,
			hint: 'Start Docker/OrbStack and verify with: docker info',
		});
		expect(readyDockerResult.checks.find((check) => check.name === 'docker-cli')).toMatchObject({
			ok: true,
			hint: 'docker',
		});
		expect(readyDockerResult.checks.find((check) => check.name === 'docker-daemon')).toMatchObject({
			ok: true,
			hint: 'docker info',
		});
	});

	it('checks Docker CLI and daemon when managed base images are configured', async () => {
		const managedBaseConfig = {
			...systemConfig,
			imageProfiles: {
				...systemConfig.imageProfiles,
				gateways: {
					openclaw: {
						...systemConfig.imageProfiles.gateways.openclaw,
						source: {
							kind: 'managedBase',
							base: 'openclaw-gateway',
						},
					},
					worker: systemConfig.imageProfiles.gateways.worker,
				},
			},
		} satisfies SystemConfig;

		const result = await runControllerDoctor({
			availableBinaries: allBinaries,
			diskFreeBytes: 50 * 1024 * 1024 * 1024,
			env: { OP_SERVICE_ACCOUNT_TOKEN: 'token' },
			occupiedPorts: new Set<number>(),
			nodeVersion: 'v25.9.0',
			requiredZigVersion: '0.15.2',
			totalMemoryBytes: 16 * 1024 * 1024 * 1024,
			zigVersion: '0.15.2',
			systemConfig: managedBaseConfig,
		});

		expect(result.ok).toBe(false);
		expect(result.checks.find((check) => check.name === 'docker-cli')).toMatchObject({
			ok: false,
		});
		expect(
			result.checks.find((check) => check.name === 'gateway-image-profile-openclaw'),
		).toMatchObject({
			ok: true,
			hint: 'type=openclaw source=managedBase base=openclaw-gateway',
		});
	});

	it('reports managed and overlay package override ownership for managed image profiles', async () => {
		const temporaryDirectoryPath = await mkdtemp(
			path.join(os.tmpdir(), 'doctor-package-overrides-'),
		);
		const overlayPath = path.join(temporaryDirectoryPath, 'overlay.jsonc');
		await writeFile(
			overlayPath,
			[
				'{',
				'  "schemaVersion": 1,',
				'  "packageOverrides": {',
				'    "openclaw": ["@openclaw/discord@2026.6.8"],',
				'    "npm": ["left-pad@1.3.0"],',
				'    "pnpm": { "undici": "8.6.0" }',
				'  }',
				'}',
				'',
			].join('\n'),
			'utf8',
		);
		const managedBaseConfig = {
			...systemConfig,
			imageProfiles: {
				...systemConfig.imageProfiles,
				gateways: {
					openclaw: {
						...systemConfig.imageProfiles.gateways.openclaw,
						source: {
							kind: 'managedBase',
							base: 'openclaw-gateway',
							overlay: overlayPath,
						},
					},
					worker: systemConfig.imageProfiles.gateways.worker,
				},
			},
		} satisfies SystemConfig;

		const checks = await collectManagedImagePackageOverrideDoctorChecks({
			managedImageRelease: createManagedImageReleaseFixture(),
			systemConfig: managedBaseConfig,
		});

		expect(checks).toHaveLength(1);
		expect(checks[0]).toMatchObject({
			name: 'gateway-package-overrides-openclaw',
			ok: true,
		});
		expect(checks[0]?.hint).toContain(
			'openclaw@2026.6.8[managed-images.json/packageOverrides.openclaw]',
		);
		expect(checks[0]?.hint).toContain(
			'@openclaw/discord@2026.6.8[overlay.jsonc/packageOverrides.openclaw]',
		);
		expect(checks[0]?.hint).toContain(
			'@openai/codex@0.139.0[managed-images.json/packageOverrides.npm]',
		);
		expect(checks[0]?.hint).toContain('left-pad@1.3.0[overlay.jsonc/packageOverrides.npm]');
		expect(checks[0]?.hint).toContain('undici@8.6.0[overlay.jsonc/packageOverrides.pnpm]');
		expect(checks[0]?.hint).toContain(`overlay ${overlayPath}`);
	});

	it('reports the exact overlay path when package override parsing fails in doctor', async () => {
		const temporaryDirectoryPath = await mkdtemp(
			path.join(os.tmpdir(), 'doctor-package-overrides-invalid-'),
		);
		const overlayPath = path.join(temporaryDirectoryPath, 'overlay.jsonc');
		await writeFile(
			overlayPath,
			[
				'{',
				'  "schemaVersion": 1,',
				'  "openClawPackageOverrides": ["@openclaw/discord@2026.6.8"]',
				'}',
				'',
			].join('\n'),
			'utf8',
		);
		const managedBaseConfig = {
			...systemConfig,
			imageProfiles: {
				...systemConfig.imageProfiles,
				gateways: {
					openclaw: {
						...systemConfig.imageProfiles.gateways.openclaw,
						source: {
							kind: 'managedBase',
							base: 'openclaw-gateway',
							overlay: overlayPath,
						},
					},
					worker: systemConfig.imageProfiles.gateways.worker,
				},
			},
		} satisfies SystemConfig;

		const checks = await collectManagedImagePackageOverrideDoctorChecks({
			managedImageRelease: createManagedImageReleaseFixture(),
			systemConfig: managedBaseConfig,
		});

		expect(checks).toContainEqual({
			name: 'gateway-package-overrides-openclaw',
			ok: false,
			hint: expect.stringContaining(overlayPath),
		});
		expect(checks[0]?.hint).toContain('move openClawPackageOverrides to packageOverrides.openclaw');
	});

	it('flags legacy Dockerfile image profiles for migration', async () => {
		const dockerBackedConfig = {
			...systemConfig,
			imageProfiles: {
				...systemConfig.imageProfiles,
				gateways: {
					openclaw: {
						...systemConfig.imageProfiles.gateways.openclaw,
						dockerfile: './vm-images/gateways/openclaw/Dockerfile',
					},
					worker: systemConfig.imageProfiles.gateways.worker,
				},
			},
		} satisfies SystemConfig;

		const result = await runControllerDoctor({
			availableBinaries: new Set([...allBinaries, 'docker']),
			diskFreeBytes: 50 * 1024 * 1024 * 1024,
			dockerDaemonReady: true,
			env: { OP_SERVICE_ACCOUNT_TOKEN: 'token' },
			occupiedPorts: new Set<number>(),
			nodeVersion: 'v25.9.0',
			requiredZigVersion: '0.15.2',
			totalMemoryBytes: 16 * 1024 * 1024 * 1024,
			zigVersion: '0.15.2',
			systemConfig: dockerBackedConfig,
		});

		expect(result.ok).toBe(false);
		expect(
			result.checks.find(
				(check) => check.name === 'legacy-dockerfile-image-profile-gateway-openclaw',
			),
		).toMatchObject({
			ok: false,
			hint: 'Run agent-vm migrate images to switch this profile to a managed base overlay.',
		});
	});

	it('flags missing or too-old Zig versions', async () => {
		const missingResult = await runControllerDoctor({
			availableBinaries: allBinaries,
			diskFreeBytes: 50 * 1024 * 1024 * 1024,
			env: { OP_SERVICE_ACCOUNT_TOKEN: 'token' },
			occupiedPorts: new Set<number>(),
			nodeVersion: 'v25.9.0',
			requiredZigVersion: '0.15.2',
			totalMemoryBytes: 16 * 1024 * 1024 * 1024,
			systemConfig,
		});
		const outdatedResult = await runControllerDoctor({
			availableBinaries: allBinaries,
			diskFreeBytes: 50 * 1024 * 1024 * 1024,
			env: { OP_SERVICE_ACCOUNT_TOKEN: 'token' },
			occupiedPorts: new Set<number>(),
			nodeVersion: 'v25.9.0',
			requiredZigVersion: '0.15.2',
			totalMemoryBytes: 16 * 1024 * 1024 * 1024,
			zigVersion: '0.15.1',
			systemConfig,
		});

		expect(missingResult.ok).toBe(false);
		expect(missingResult.checks.find((check) => check.name === 'zig-version')).toMatchObject({
			ok: false,
			hint: 'Install Zig >= 0.15.2. On macOS: brew install zig.',
		});
		expect(outdatedResult.ok).toBe(false);
		expect(outdatedResult.checks.find((check) => check.name === 'zig-version')).toMatchObject({
			ok: false,
			value: '0.15.1',
			hint: 'Requires Zig >= 0.15.2. On macOS: brew install zig.',
		});
	});

	it('does not require optional 1Password CLI or age binaries for env-backed configs', async () => {
		const result = await runControllerDoctor({
			availableBinaries: allBinaries,
			diskFreeBytes: 50 * 1024 * 1024 * 1024,
			env: { OP_SERVICE_ACCOUNT_TOKEN: 'token' },
			occupiedPorts: new Set<number>(),
			nodeVersion: 'v25.9.0',
			totalMemoryBytes: 16 * 1024 * 1024 * 1024,
			systemConfig: createExternalObservabilitySystemConfig(),
		});

		expect(result.ok).toBe(true);
		expect(result.checks.find((check) => check.name === 'age')).toBeUndefined();
		expect(result.checks.find((check) => check.name === '1password-cli')).toBeUndefined();
	});

	it('flags missing qemu with an install hint', async () => {
		const result = await runControllerDoctor({
			availableBinaries: new Set<string>(),
			diskFreeBytes: 50 * 1024 * 1024 * 1024,
			env: { OP_SERVICE_ACCOUNT_TOKEN: 'token' },
			occupiedPorts: new Set<number>(),
			nodeVersion: 'v25.9.0',
			totalMemoryBytes: 16 * 1024 * 1024 * 1024,
			systemConfig,
		});

		expect(result.ok).toBe(false);
		const qemuCheck = result.checks.find((check) => check.name === 'qemu');
		expect(qemuCheck?.ok).toBe(false);
		expect(qemuCheck?.hint).toBe('Install QEMU (for example: brew install qemu).');
	});

	it('flags missing OpenClaw CLI for OpenClaw gateway configs', async () => {
		const result = await runControllerDoctor({
			availableBinaries: new Set([...allBinaries].filter((binary) => binary !== 'openclaw')),
			diskFreeBytes: 50 * 1024 * 1024 * 1024,
			env: { OP_SERVICE_ACCOUNT_TOKEN: 'token' },
			occupiedPorts: new Set<number>(),
			nodeVersion: 'v25.9.0',
			totalMemoryBytes: 16 * 1024 * 1024 * 1024,
			systemConfig,
		});

		expect(result.ok).toBe(false);
		expect(result.checks.find((check) => check.name === 'openclaw-cli')).toMatchObject({
			ok: false,
			hint: 'Install OpenClaw in this catalog for local schema validation: pnpm add -D openclaw@2026.6.8.',
		});
	});

	it('flags occupied ports and insufficient resources', async () => {
		const result = await runControllerDoctor({
			availableBinaries: allBinaries,
			diskFreeBytes: 1,
			env: {},
			occupiedPorts: new Set<number>([18800, 18791]),
			nodeVersion: 'v20.0.0',
			totalMemoryBytes: 512 * 1024 * 1024,
			systemConfig,
		});

		expect(result.ok).toBe(false);
		expect(result.checks.find((check) => check.name === 'node-version')?.ok).toBe(false);
		expect(result.checks.find((check) => check.name === '1password-token-source')?.ok).toBe(false);
		expect(result.checks.find((check) => check.name === 'controller-port')?.ok).toBe(false);
		expect(result.checks.find((check) => check.name === 'disk-space')?.ok).toBe(false);
	});

	it('flags controllerRuntimeDir overlap with cache, state, and zone files paths', async () => {
		const overlappingConfigs = [
			{
				controllerRuntimeDir: './cache/runtime',
				expectedHint: 'controllerRuntimeDir must not overlap cacheDir',
			},
			{
				cacheDir: './runtime/cache',
				expectedHint: 'controllerRuntimeDir must not overlap cacheDir',
			},
			{
				controllerRuntimeDir: './state/shravan/runtime',
				expectedHint: "controllerRuntimeDir must not overlap stateDir for zone 'shravan'",
			},
			{
				stateDir: './runtime/state/shravan',
				expectedHint: "controllerRuntimeDir must not overlap stateDir for zone 'shravan'",
			},
			{
				controllerRuntimeDir: './zone-files/shravan/runtime',
				expectedHint: "controllerRuntimeDir must not overlap zoneFilesDir for zone 'shravan'",
			},
			{
				zoneFilesDir: './runtime/zone-files/shravan',
				expectedHint: "controllerRuntimeDir must not overlap zoneFilesDir for zone 'shravan'",
			},
		] satisfies readonly RuntimePathOverlapCase[];

		for (const overlappingConfig of overlappingConfigs) {
			const firstZone = systemConfig.zones[0];
			if (firstZone === undefined || firstZone.gateway.type !== 'openclaw') {
				throw new Error('Test fixture must include an OpenClaw zone.');
			}
			// oxlint-disable-next-line no-await-in-loop -- each table case is asserted independently in declaration order.
			const result = await runControllerDoctor({
				availableBinaries: allBinaries,
				diskFreeBytes: 50 * 1024 * 1024 * 1024,
				env: { OP_SERVICE_ACCOUNT_TOKEN: 'token' },
				occupiedPorts: new Set<number>(),
				nodeVersion: 'v25.9.0',
				totalMemoryBytes: 16 * 1024 * 1024 * 1024,
				systemConfig: {
					...systemConfig,
					cacheDir: overlappingConfig.cacheDir ?? systemConfig.cacheDir,
					controllerRuntimeDir:
						overlappingConfig.controllerRuntimeDir ?? systemConfig.controllerRuntimeDir,
					zones: [
						{
							...firstZone,
							gateway: {
								...firstZone.gateway,
								stateDir: overlappingConfig.stateDir ?? firstZone.gateway.stateDir,
								zoneFilesDir: overlappingConfig.zoneFilesDir ?? firstZone.gateway.zoneFilesDir,
							},
						},
					],
				},
			});

			expect(result.ok).toBe(false);
			expect(
				result.checks.find((check) => check.hint === overlappingConfig.expectedHint),
			).toMatchObject({
				ok: false,
				hint: overlappingConfig.expectedHint,
			});
		}
	});

	it('reports every controllerRuntimeDir overlap in one doctor run', async () => {
		const firstZone = systemConfig.zones[0];
		if (firstZone === undefined || firstZone.gateway.type !== 'openclaw') {
			throw new Error('Test fixture must include an OpenClaw zone.');
		}
		const result = await runControllerDoctor({
			availableBinaries: allBinaries,
			diskFreeBytes: 50 * 1024 * 1024 * 1024,
			env: { OP_SERVICE_ACCOUNT_TOKEN: 'token' },
			occupiedPorts: new Set<number>(),
			nodeVersion: 'v25.9.0',
			totalMemoryBytes: 16 * 1024 * 1024 * 1024,
			systemConfig: {
				...systemConfig,
				cacheDir: './runtime/cache',
				controllerRuntimeDir: './runtime',
				zones: [
					{
						...firstZone,
						gateway: {
							...firstZone.gateway,
							stateDir: './runtime/state/shravan',
							zoneFilesDir: './runtime/zone-files/shravan',
						},
					},
				],
			},
		});

		expect(result.checks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: 'runtime-path-isolation-cacheDir' }),
				expect.objectContaining({ name: 'runtime-path-isolation-stateDir-shravan' }),
				expect.objectContaining({ name: 'runtime-path-isolation-zoneFilesDir-shravan' }),
			]),
		);
	});

	it('flags worker /work VFS mounts as a performance risk', async () => {
		const result = await runControllerDoctor({
			availableBinaries: allBinaries,
			diskFreeBytes: 50 * 1024 * 1024 * 1024,
			env: { OP_SERVICE_ACCOUNT_TOKEN: 'token' },
			occupiedPorts: new Set<number>(),
			nodeVersion: 'v25.9.0',
			totalMemoryBytes: 16 * 1024 * 1024 * 1024,
			systemConfig: createWorkerOnlySystemConfig(),
			workerGatewayVmRequirementsBuilder: () => ({
				mounts: {
					'/work/repos': {
						access: 'read-write',
						hostPath: '/host/work/repos',
						kind: 'host-directory',
					},
				},
			}),
		});

		expect(result.ok).toBe(false);
		expect(result.checks.find((check) => check.name === 'worker-work-rootfs-worker')).toMatchObject(
			{
				ok: false,
				hint: "Worker zone 'worker' mounts '/work/repos' through VFS; /work must stay on rootfs/COW.",
			},
		);
	});
});

describe('collectVmHostSystemDoctorCheck', () => {
	it('flags incomplete vm-host-system directories', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'doctor-host-'));
		const configPath = path.join(temporaryDirectoryPath, 'config', 'system.json');
		const vmHostSystemPath = path.join(temporaryDirectoryPath, 'vm-host-system');
		await mkdir(path.dirname(configPath), { recursive: true });
		await mkdir(vmHostSystemPath, { recursive: true });

		const check = await collectVmHostSystemDoctorCheck(
			createLoadedSystemConfig(createSystemConfigInputFromResolvedFixture(systemConfig), {
				systemConfigPath: configPath,
			}),
		);

		expect(check).toMatchObject({
			name: 'vm-host-system',
			ok: false,
		});
		expect(check?.hint).toContain('vm-host-system/Dockerfile');
	});

	it('passes when vm-host-system files exist', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'doctor-host-'));
		const configPath = path.join(temporaryDirectoryPath, 'config', 'system.json');
		const vmHostSystemPath = path.join(temporaryDirectoryPath, 'vm-host-system');
		await mkdir(path.dirname(configPath), { recursive: true });
		await mkdir(vmHostSystemPath, { recursive: true });
		await Promise.all(
			['Dockerfile', 'start.sh', 'agent-vm-controller.service'].map(async (fileName) => {
				await writeFile(path.join(vmHostSystemPath, fileName), '', 'utf8');
			}),
		);

		const check = await collectVmHostSystemDoctorCheck(
			createLoadedSystemConfig(createSystemConfigInputFromResolvedFixture(systemConfig), {
				systemConfigPath: configPath,
			}),
		);

		expect(check).toMatchObject({
			name: 'vm-host-system',
			ok: true,
			hint: vmHostSystemPath,
		});
	});

	it('checks runtime host files inside /etc/agent-vm container configs', async () => {
		const check = await collectVmHostSystemDoctorCheck({
			...createLoadedSystemConfig(createSystemConfigInputFromResolvedFixture(systemConfig), {
				systemConfigPath: '/etc/agent-vm/system.json',
			}),
		});

		expect(check).toMatchObject({
			name: 'vm-host-system',
			ok: false,
			hint: expect.stringContaining('Cannot access /usr/local/bin/start.sh'),
		});
	});

	it('flags missing vm-host-system directories for container checkout configs', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'doctor-host-'));
		const configPath = path.join(temporaryDirectoryPath, 'config', 'system.json');
		await mkdir(path.dirname(configPath), { recursive: true });

		const containerSystemConfig = {
			...systemConfig,
			imageProfiles: {
				...systemConfig.imageProfiles,
				gateways: {
					openclaw: {
						...systemConfig.imageProfiles.gateways.openclaw,
						buildConfig: '/etc/agent-vm/vm-images/gateways/openclaw/build-config.json',
					},
					worker: {
						...systemConfig.imageProfiles.gateways.worker,
						buildConfig: '/etc/agent-vm/vm-images/gateways/worker/build-config.json',
					},
				},
			},
		} satisfies SystemConfig;

		const check = await collectVmHostSystemDoctorCheck(
			createLoadedSystemConfig(createSystemConfigInputFromResolvedFixture(containerSystemConfig), {
				systemConfigPath: configPath,
			}),
		);

		expect(check).toMatchObject({
			name: 'vm-host-system',
			ok: false,
			hint: expect.stringContaining('vm-host-system'),
		});
	});

	it('skips vm-host-system checks for local configs when the directory is absent', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'doctor-host-'));
		const configPath = path.join(temporaryDirectoryPath, 'config', 'system.json');
		await mkdir(path.dirname(configPath), { recursive: true });

		await expect(
			collectVmHostSystemDoctorCheck(
				createLoadedSystemConfig(createSystemConfigInputFromResolvedFixture(systemConfig), {
					systemConfigPath: configPath,
				}),
			),
		).resolves.toBeNull();
	});
});
