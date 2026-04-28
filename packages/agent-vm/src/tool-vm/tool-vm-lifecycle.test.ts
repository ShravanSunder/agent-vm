import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ManagedVm } from '@agent-vm/gondolin-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import { createToolVm } from './tool-vm-lifecycle.js';

const createdDirectories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const directoryPath of createdDirectories.splice(0)) {
		fs.rmSync(directoryPath, { recursive: true, force: true });
	}
});

function createTemporaryDirectory(): string {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-tool-vm-lifecycle-'));
	createdDirectories.push(temporaryDirectory);
	return temporaryDirectory;
}

function createToolVmSystemConfig(): LoadedSystemConfig {
	const temporaryDirectory = createTemporaryDirectory();
	const systemConfigPath = path.join(temporaryDirectory, 'config', 'system.json');

	return createLoadedSystemConfig(
		{
			cacheDir: path.join(temporaryDirectory, 'cache'),
			host: {
				controllerPort: 18800,
				projectNamespace: 'claw-tests-a1b2c3d4',
				secretsProvider: {
					type: '1password',
					tokenSource: { type: 'env' },
				},
			},
			imageProfiles: {
				gateways: {
					openclaw: {
						type: 'openclaw',
						buildConfig: '/project/vm-images/gateways/openclaw/build-config.json',
					},
					worker: {
						type: 'worker',
						buildConfig: '/project/vm-images/gateways/worker/build-config.json',
					},
				},
				toolVms: {
					default: {
						type: 'toolVm',
						buildConfig: '/project/vm-images/tool-vms/default/build-config.json',
					},
				},
			},
			tcpPool: {
				basePort: 19000,
				size: 5,
			},
			toolProfiles: {
				standard: {
					cpus: 1,
					imageProfile: 'default',
					memory: '1G',
					workspaceRoot: path.join(temporaryDirectory, 'workspaces', 'tools'),
				},
			},
			zones: [
				{
					allowedHosts: ['api.anthropic.com'],
					gateway: {
						type: 'openclaw',
						imageProfile: 'openclaw',
						cpus: 2,
						memory: '2G',
						config: './config/shravan/openclaw.json',
						port: 18791,
						stateDir: './state/shravan',
						zoneFilesDir: './zone-files/shravan',
					},
					id: 'shravan',
					secrets: {},
					toolProfile: 'standard',
					websocketBypass: [],
				},
			],
		},
		{ systemConfigPath },
	);
}

describe('createToolVm', () => {
	it('creates the tool VM without running redundant runtime setup commands', async () => {
		const exec = vi.fn(async () => ({
			exitCode: 0,
			stderr: '',
			stdout: '',
		}));
		const managedVm = {
			close: async () => {},
			enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
			enableSsh: async () => ({ host: '127.0.0.1', port: 19000 }),
			exec,
			getVmInstance: () => ({
				close: async () => {},
				enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
				enableSsh: async () => ({ host: '127.0.0.1', port: 19000 }),
				exec: async () => ({ exitCode: 0 }),
				id: 'vm-instance',
				setIngressRoutes: () => {},
			}),
			id: 'managed-vm',
			setIngressRoutes: () => {},
		} satisfies ManagedVm;

		const systemConfig = createToolVmSystemConfig();
		const standardProfile = systemConfig.toolProfiles.standard;
		if (!standardProfile) {
			throw new Error('Expected standard tool profile');
		}
		const buildGondolinImage = vi.fn(async () => ({
			built: true,
			fingerprint: 'tool-fingerprint',
			imagePath: '/cache/tool-fingerprint',
		}));

		const result = await createToolVm(
			{
				cacheDir: systemConfig.cacheDir,
				profile: standardProfile,
				systemConfig,
				tcpSlot: 0,
				workspaceDir: '/workspace',
				zoneId: 'shravan',
			},
			{
				buildGondolinImage,
				createManagedVm: async () => managedVm,
			},
		);

		expect(result).toBe(managedVm);
		expect(buildGondolinImage).toHaveBeenCalledWith({
			buildConfigPath: '/project/vm-images/tool-vms/default/build-config.json',
			systemCacheIdentifierPath: systemConfig.systemCacheIdentifierPath,
			cacheDir: path.join(systemConfig.cacheDir, 'tool-vm-images', 'default'),
		});
		expect(exec).not.toHaveBeenCalled();
	});

	it('does not use mkdirSync inside the async createToolVm path', async () => {
		const mkdirSyncSpy = vi.spyOn(fs, 'mkdirSync');
		const managedVm = {
			close: async () => {},
			enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
			enableSsh: async () => ({ host: '127.0.0.1', port: 19000 }),
			exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
			getVmInstance: () => ({
				close: async () => {},
				enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
				enableSsh: async () => ({ host: '127.0.0.1', port: 19000 }),
				exec: async () => ({ exitCode: 0 }),
				id: 'vm-instance',
				setIngressRoutes: () => {},
			}),
			id: 'managed-vm',
			setIngressRoutes: () => {},
		} satisfies ManagedVm;

		const systemConfig = createToolVmSystemConfig();
		const standardProfile = systemConfig.toolProfiles.standard;
		if (!standardProfile) {
			throw new Error('Expected standard tool profile');
		}

		await createToolVm(
			{
				cacheDir: systemConfig.cacheDir,
				profile: standardProfile,
				systemConfig,
				tcpSlot: 1,
				workspaceDir: '/workspace',
				zoneId: 'shravan',
			},
			{
				buildGondolinImage: async () => ({
					built: true,
					fingerprint: 'tool-fingerprint',
					imagePath: '/cache/tool-fingerprint',
				}),
				createManagedVm: async () => managedVm,
			},
		);

		expect(mkdirSyncSpy).not.toHaveBeenCalled();
	});
});
