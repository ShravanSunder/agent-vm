import { describe, expect, it } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import { runControllerDoctor } from './doctor.js';

const systemConfig = {
	cacheDir: './cache',
	host: {
		controllerPort: 18800,
		secretsProvider: {
			type: '1password',
			tokenSource: {
				type: 'env',
				envVar: 'OP_SERVICE_ACCOUNT_TOKEN',
			},
		},
	},
	images: {
		gateway: {
			buildConfig: './images/gateway/build-config.json',
		},
		tool: {
			buildConfig: './images/tool/build-config.json',
		},
	},
	zones: [
		{
			id: 'shravan',
			gateway: {
				type: 'openclaw',
				memory: '2G',
				cpus: 2,
				port: 18791,
				gatewayConfig: './config/shravan/openclaw.json',
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
		},
	},
	tcpPool: {
		basePort: 19000,
		size: 5,
	},
} satisfies SystemConfig;

const allBinaries = new Set(['qemu-system-aarch64', 'age', 'op', 'security']);

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
		expect(result.checks.find((check) => check.name === 'age')?.ok).toBe(true);
		expect(result.checks.find((check) => check.name === '1password-cli')?.ok).toBe(true);
	});

	it('flags missing binaries with install hints', () => {
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
		expect(qemuCheck?.hint).toBe('brew install qemu');

		const ageCheck = result.checks.find((check) => check.name === 'age');
		expect(ageCheck?.ok).toBe(false);
		expect(ageCheck?.hint).toBe('brew install age');
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
