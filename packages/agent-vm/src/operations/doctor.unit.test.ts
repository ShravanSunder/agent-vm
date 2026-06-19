import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createLoadedSystemConfig, type SystemConfig } from '../config/system-config.js';
import { collectVmHostSystemDoctorCheck, runControllerDoctor } from './doctor.js';

const systemConfig = {
	schemaVersion: 1,
	cacheDir: './cache',
	runtimeDir: './runtime',
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
			websocketBypass: [],
			defaultToolVmProfile: 'standard',
			agentToolVmProfiles: {},
			agentSandboxSeeds: {
				shravan: [
					{
						source: { source: 'environment', envVar: 'SHRAVAN_GCLOUD_CONFIG' },
						target: '.config/gcloud/configurations/config_default',
						mode: 0o600,
					},
				],
			},
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

interface RuntimePathOverlapCase {
	readonly cacheDir?: string;
	readonly expectedHint: string;
	readonly runtimeDir?: string;
	readonly stateDir?: string;
	readonly zoneFilesDir?: string;
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
				},
				secrets: {},
				egressHosts: ['api.openai.com'].map((host) => ({ host, audience: 'gateway' as const })),
				websocketBypass: [],
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
	it('reports all checks passing when environment is complete', () => {
		const result = runControllerDoctor({
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
		expect(
			result.checks.find((check) => check.name === 'zone-agent-sandbox-seed-shravan-shravan-0'),
		).toMatchObject({
			ok: true,
			hint: '.config/gcloud/configurations/config_default',
		});
		expect(result.checks.find((check) => check.name === 'age')).toBeUndefined();
		expect(result.checks.find((check) => check.name === '1password-cli')).toBeUndefined();
		expect(result.checks.find((check) => check.name === 'observability-enabled')).toMatchObject({
			ok: true,
			hint: 'external',
		});
		expect(result.checks.find((check) => check.name === 'docker-cli')).toBeUndefined();
	});

	it('reports Tool VM mediated secret agent access', () => {
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

		const result = runControllerDoctor({
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

	it('recommends managed observability when host observability is omitted', () => {
		const result = runControllerDoctor({
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

	it('requires Docker only for managed observability stacks', () => {
		const missingDockerResult = runControllerDoctor({
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
		const readyDockerResult = runControllerDoctor({
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

	it('checks Docker CLI and daemon when Docker-backed images are configured', () => {
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

		const missingDockerResult = runControllerDoctor({
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
		const readyDockerResult = runControllerDoctor({
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

	it('checks Docker CLI and daemon when managed base images are configured', () => {
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

		const result = runControllerDoctor({
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

	it('flags legacy Dockerfile image profiles for migration', () => {
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

		const result = runControllerDoctor({
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

	it('flags missing or too-old Zig versions', () => {
		const missingResult = runControllerDoctor({
			availableBinaries: allBinaries,
			diskFreeBytes: 50 * 1024 * 1024 * 1024,
			env: { OP_SERVICE_ACCOUNT_TOKEN: 'token' },
			occupiedPorts: new Set<number>(),
			nodeVersion: 'v25.9.0',
			requiredZigVersion: '0.15.2',
			totalMemoryBytes: 16 * 1024 * 1024 * 1024,
			systemConfig,
		});
		const outdatedResult = runControllerDoctor({
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

	it('does not require optional 1Password CLI or age binaries for env-backed configs', () => {
		const result = runControllerDoctor({
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

	it('flags missing qemu with an install hint', () => {
		const result = runControllerDoctor({
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

	it('flags missing OpenClaw CLI for OpenClaw gateway configs', () => {
		const result = runControllerDoctor({
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

	it('flags occupied ports and insufficient resources', () => {
		const result = runControllerDoctor({
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

	it('flags runtimeDir overlap with cache, state, and zone files paths', () => {
		const overlappingConfigs = [
			{
				runtimeDir: './cache/runtime',
				expectedHint: 'runtimeDir must not overlap cacheDir',
			},
			{
				cacheDir: './runtime/cache',
				expectedHint: 'runtimeDir must not overlap cacheDir',
			},
			{
				runtimeDir: './state/shravan/runtime',
				expectedHint: "runtimeDir must not overlap stateDir for zone 'shravan'",
			},
			{
				stateDir: './runtime/state/shravan',
				expectedHint: "runtimeDir must not overlap stateDir for zone 'shravan'",
			},
			{
				runtimeDir: './zone-files/shravan/runtime',
				expectedHint: "runtimeDir must not overlap zoneFilesDir for zone 'shravan'",
			},
			{
				zoneFilesDir: './runtime/zone-files/shravan',
				expectedHint: "runtimeDir must not overlap zoneFilesDir for zone 'shravan'",
			},
		] satisfies readonly RuntimePathOverlapCase[];

		for (const overlappingConfig of overlappingConfigs) {
			const firstZone = systemConfig.zones[0];
			if (firstZone === undefined || firstZone.gateway.type !== 'openclaw') {
				throw new Error('Test fixture must include an OpenClaw zone.');
			}
			const result = runControllerDoctor({
				availableBinaries: allBinaries,
				diskFreeBytes: 50 * 1024 * 1024 * 1024,
				env: { OP_SERVICE_ACCOUNT_TOKEN: 'token' },
				occupiedPorts: new Set<number>(),
				nodeVersion: 'v25.9.0',
				totalMemoryBytes: 16 * 1024 * 1024 * 1024,
				systemConfig: {
					...systemConfig,
					cacheDir: overlappingConfig.cacheDir ?? systemConfig.cacheDir,
					runtimeDir: overlappingConfig.runtimeDir ?? systemConfig.runtimeDir,
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

	it('reports every runtimeDir overlap in one doctor run', () => {
		const firstZone = systemConfig.zones[0];
		if (firstZone === undefined || firstZone.gateway.type !== 'openclaw') {
			throw new Error('Test fixture must include an OpenClaw zone.');
		}
		const result = runControllerDoctor({
			availableBinaries: allBinaries,
			diskFreeBytes: 50 * 1024 * 1024 * 1024,
			env: { OP_SERVICE_ACCOUNT_TOKEN: 'token' },
			occupiedPorts: new Set<number>(),
			nodeVersion: 'v25.9.0',
			totalMemoryBytes: 16 * 1024 * 1024 * 1024,
			systemConfig: {
				...systemConfig,
				cacheDir: './runtime/cache',
				runtimeDir: './runtime',
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

	it('flags worker /work VFS mounts as a performance risk', () => {
		const result = runControllerDoctor({
			availableBinaries: allBinaries,
			diskFreeBytes: 50 * 1024 * 1024 * 1024,
			env: { OP_SERVICE_ACCOUNT_TOKEN: 'token' },
			occupiedPorts: new Set<number>(),
			nodeVersion: 'v25.9.0',
			totalMemoryBytes: 16 * 1024 * 1024 * 1024,
			systemConfig: createWorkerOnlySystemConfig(),
			workerGatewayVmSpecBuilder: () => ({
				vfsMounts: {
					'/work/repos': {
						hostPath: '/host/work/repos',
						kind: 'realfs',
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
			createLoadedSystemConfig(systemConfig, { systemConfigPath: configPath }),
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
			createLoadedSystemConfig(systemConfig, { systemConfigPath: configPath }),
		);

		expect(check).toMatchObject({
			name: 'vm-host-system',
			ok: true,
			hint: vmHostSystemPath,
		});
	});

	it('checks runtime host files inside /etc/agent-vm container configs', async () => {
		const check = await collectVmHostSystemDoctorCheck({
			...createLoadedSystemConfig(systemConfig, {
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
			createLoadedSystemConfig(containerSystemConfig, { systemConfigPath: configPath }),
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
				createLoadedSystemConfig(systemConfig, { systemConfigPath: configPath }),
			),
		).resolves.toBeNull();
	});
});
