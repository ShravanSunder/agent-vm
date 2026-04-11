import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ManagedVm } from 'gondolin-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SystemConfig } from '../controller/system-config.js';
import { createToolVm } from './tool-vm-lifecycle.js';

const createdDirectories: string[] = [];

afterEach(() => {
	for (const directoryPath of createdDirectories.splice(0)) {
		fs.rmSync(directoryPath, { recursive: true, force: true });
	}
});

function createTemporaryDirectory(): string {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-tool-vm-lifecycle-'));
	createdDirectories.push(temporaryDirectory);
	return temporaryDirectory;
}

function createToolVmSystemConfig(): SystemConfig {
	const temporaryDirectory = createTemporaryDirectory();

	return {
		cacheDir: path.join(temporaryDirectory, 'cache'),
		host: {
			controllerPort: 18800,
			secretsProvider: {
				type: '1password',
				tokenSource: { type: 'env' },
			},
		},
		images: {
			gateway: {
				buildConfig: '/project/images/gateway/build-config.json',
			},
			tool: {
				buildConfig: '/project/images/tool/build-config.json',
			},
		},
		tcpPool: {
			basePort: 19000,
			size: 5,
		},
		toolProfiles: {
			standard: {
				cpus: 1,
				memory: '1G',
				workspaceRoot: path.join(temporaryDirectory, 'workspaces', 'tools'),
			},
		},
		zones: [
			{
				allowedHosts: ['api.anthropic.com'],
				gateway: {
					cpus: 2,
					memory: '2G',
					openclawConfig: './config/shravan/openclaw.json',
					port: 18791,
					stateDir: './state/shravan',
					workspaceDir: './workspaces/shravan',
				},
				id: 'shravan',
				secrets: {},
				toolProfile: 'standard',
				websocketBypass: [],
			},
		],
	};
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
			buildConfigPath: '/project/images/tool/build-config.json',
			cacheDir: path.join(systemConfig.cacheDir, 'images', 'tool'),
		});
		expect(exec).not.toHaveBeenCalled();
	});
});
