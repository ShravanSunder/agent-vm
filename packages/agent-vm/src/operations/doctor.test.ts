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

const allBinaries = new Set(['qemu-system-aarch64', 'qemu-system-x86_64', 'op', 'security']);

describe('runControllerDoctor', () => {
	it('reports all checks passing when environment is complete', () => {
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
		expect(result.checks.every((check) => check.ok)).toBe(true);
		expect(result.checks.find((check) => check.name === 'qemu')?.ok).toBe(true);
		expect(result.checks.find((check) => check.name === 'age')).toBeUndefined();
		expect(result.checks.find((check) => check.name === '1password-cli')).toBeUndefined();
	});

	it('does not require optional 1Password CLI or age binaries for env-backed configs', () => {
		const result = runControllerDoctor({
			availableBinaries: new Set<string>(['qemu-system-aarch64']),
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
