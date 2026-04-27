import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createLoadedSystemConfig, type SystemConfig } from '../config/system-config.js';
import { collectVmHostSystemDoctorCheck, runControllerDoctor } from './doctor.js';

const systemConfig = {
	cacheDir: './cache',
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
				imageProfile: 'openclaw',
				memory: '2G',
				cpus: 2,
				port: 18791,
				config: './config/shravan/openclaw.json',
				stateDir: './state/shravan',
				workspaceDir: './workspaces/shravan',
			},
			secrets: {},
			allowedHosts: ['api.anthropic.com'],
			websocketBypass: [],
			toolProfile: 'standard',
		},
	],
	toolProfiles: {
		standard: {
			memory: '1G',
			cpus: 1,
			workspaceRoot: './workspaces/tools',
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
			systemConfig,
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
		expect(result.checks.find((check) => check.name === 'age')).toBeUndefined();
		expect(result.checks.find((check) => check.name === '1password-cli')).toBeUndefined();
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
			systemConfig,
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
			hint: 'Install OpenClaw in this catalog for local schema validation: pnpm add -D openclaw@2026.4.24.',
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

	it('reports ok for op-cli token source when op binary is available', () => {
		const opCliConfig = {
			...systemConfig,
			host: {
				...systemConfig.host,
				secretsProvider: {
					type: '1password' as const,
					tokenSource: {
						type: 'op-cli' as const,
						ref: 'op://agent-vm/agent-1p-service-account/password',
					},
				},
			},
		};

		const result = runControllerDoctor({
			availableBinaries: allBinaries,
			diskFreeBytes: 50 * 1024 * 1024 * 1024,
			env: {},
			occupiedPorts: new Set<number>(),
			nodeVersion: 'v25.9.0',
			totalMemoryBytes: 16 * 1024 * 1024 * 1024,
			systemConfig: opCliConfig,
		});

		const tokenCheck = result.checks.find((check) => check.name === '1password-token-source');
		expect(tokenCheck?.ok).toBe(true);
	});

	it('flags op-cli token source when op binary is missing', () => {
		const opCliConfig = {
			...systemConfig,
			host: {
				...systemConfig.host,
				secretsProvider: {
					type: '1password' as const,
					tokenSource: {
						type: 'op-cli' as const,
						ref: 'op://agent-vm/agent-1p-service-account/password',
					},
				},
			},
		};

		const result = runControllerDoctor({
			availableBinaries: new Set<string>(),
			diskFreeBytes: 50 * 1024 * 1024 * 1024,
			env: {},
			occupiedPorts: new Set<number>(),
			nodeVersion: 'v25.9.0',
			totalMemoryBytes: 16 * 1024 * 1024 * 1024,
			systemConfig: opCliConfig,
		});

		const tokenCheck = result.checks.find((check) => check.name === '1password-token-source');
		expect(tokenCheck?.ok).toBe(false);
		expect(tokenCheck?.hint).toContain('1password-cli');
	});
});

describe('collectVmHostSystemDoctorCheck', () => {
	it('flags missing vm-host-system files for container configs', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-host-'));
		const configPath = path.join(temporaryDirectoryPath, 'config', 'system.json');
		await fs.mkdir(path.dirname(configPath), { recursive: true });
		await fs.writeFile(
			path.join(path.dirname(configPath), 'systemCacheIdentifier.json'),
			JSON.stringify({ hostSystemType: 'container' }),
			'utf8',
		);

		const check = await collectVmHostSystemDoctorCheck(
			createLoadedSystemConfig(systemConfig, { systemConfigPath: configPath }),
		);

		expect(check).toMatchObject({
			name: 'vm-host-system',
			ok: false,
		});
		expect(check?.hint).toContain('vm-host-system/Dockerfile');
	});

	it('passes when vm-host-system files exist for container configs', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-host-'));
		const configPath = path.join(temporaryDirectoryPath, 'config', 'system.json');
		const vmHostSystemPath = path.join(temporaryDirectoryPath, 'vm-host-system');
		await fs.mkdir(path.dirname(configPath), { recursive: true });
		await fs.mkdir(vmHostSystemPath, { recursive: true });
		await fs.writeFile(
			path.join(path.dirname(configPath), 'systemCacheIdentifier.json'),
			JSON.stringify({ hostSystemType: 'container' }),
			'utf8',
		);
		await Promise.all(
			['Dockerfile', 'start.sh', 'agent-vm-controller.service'].map(async (fileName) => {
				await fs.writeFile(path.join(vmHostSystemPath, fileName), '', 'utf8');
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

	it('skips vm-host-system checks for non-container configs', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-host-'));
		const configPath = path.join(temporaryDirectoryPath, 'config', 'system.json');
		await fs.mkdir(path.dirname(configPath), { recursive: true });
		await fs.writeFile(
			path.join(path.dirname(configPath), 'systemCacheIdentifier.json'),
			JSON.stringify({ hostSystemType: 'bare-metal' }),
			'utf8',
		);

		await expect(
			collectVmHostSystemDoctorCheck(
				createLoadedSystemConfig(systemConfig, { systemConfigPath: configPath }),
			),
		).resolves.toBeNull();
	});
});
