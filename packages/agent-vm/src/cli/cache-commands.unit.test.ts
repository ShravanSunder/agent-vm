import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	createLoadedSystemConfig,
	deploymentCacheDirForSystemConfig,
	deploymentGeneratedDirForStorageRoot,
	sharedImageCacheDirForStorageRoot,
	type LoadedSystemConfig,
} from '../config/system-config.js';
import { runCacheCommand } from './cache-commands.js';

const temporaryDirectories: string[] = [];

async function createSystemConfig(): Promise<LoadedSystemConfig> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-cache-command-'));
	temporaryDirectories.push(root);
	const storageRootDir = path.join(root, 'deployment');
	const buildConfigPath = path.join(root, 'build-config.jsonc');
	await fs.mkdir(storageRootDir, { recursive: true });
	await fs.writeFile(
		buildConfigPath,
		JSON.stringify({ arch: 'aarch64', distro: 'alpine' }),
		'utf8',
	);
	return createLoadedSystemConfig(
		{
			schemaVersion: 2,
			storageRootDir,
			host: { controllerPort: 18800, projectNamespace: 'cache-command-test' },
			imageProfiles: {
				gateways: { worker: { type: 'worker', buildConfig: buildConfigPath } },
				toolVms: { default: { type: 'toolVm', buildConfig: buildConfigPath } },
			},
			zones: [
				{
					id: 'worker',
					gateway: {
						type: 'worker',
						imageProfile: 'worker',
						config: path.join(root, 'worker.jsonc'),
						cpus: 1,
						memory: '1G',
						port: 18791,
					},
					secrets: {},
					egressHosts: [{ audience: 'gateway', host: 'example.com' }],
				},
			],
			toolVmProfiles: {
				standard: { cpus: 1, imageProfile: 'default', memory: '1G' },
			},
			tcpPool: { basePort: 19000, size: 2 },
		},
		{ systemConfigPath: path.join(root, 'config', 'system.jsonc') },
	);
}

function createIo(): {
	readonly io: {
		readonly stderr: { write(value: string | Uint8Array): boolean };
		readonly stdout: { write(value: string | Uint8Array): boolean };
	};
	readonly stderr: string[];
	readonly stdout: string[];
} {
	const stderr: string[] = [];
	const stdout: string[] = [];
	return {
		io: {
			stderr: { write: (value: string | Uint8Array) => stderr.push(String(value)) > 0 },
			stdout: { write: (value: string | Uint8Array) => stdout.push(String(value)) > 0 },
		},
		stderr,
		stdout,
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map(async (directoryPath) => await fs.rm(directoryPath, { recursive: true, force: true })),
	);
});

describe('runCacheCommand', () => {
	it('lists one central cache, one deployment scope, and generated selections', async () => {
		const systemConfig = await createSystemConfig();
		const { io, stdout } = createIo();

		await runCacheCommand({ subcommand: 'list', systemConfig }, io);

		const output = JSON.parse(stdout.join('')) as Record<string, unknown>;
		expect(output).toMatchObject({
			cacheDir: systemConfig.cacheDir,
			deploymentCacheDir: deploymentCacheDirForSystemConfig(systemConfig),
			deploymentGeneratedDir: deploymentGeneratedDirForStorageRoot(systemConfig.storageRootDir),
			sharedImageCacheDir: sharedImageCacheDirForStorageRoot(systemConfig.storageRootDir),
			sharedImageFingerprints: [],
		});
	});

	it('reports deployment cleanup targets without deleting when confirmation is absent', async () => {
		const systemConfig = await createSystemConfig();
		const { io, stderr } = createIo();
		const acquireControllerOwnershipLock = vi.fn();
		const removeDirectory = vi.fn();

		await runCacheCommand({ subcommand: 'clean', systemConfig }, io, {
			acquireControllerOwnershipLock,
			removeDirectory,
		});

		expect(stderr.join('')).toContain(
			'Shared VM images and deployment-generated metadata are preserved',
		);
		expect(acquireControllerOwnershipLock).not.toHaveBeenCalled();
		expect(removeDirectory).not.toHaveBeenCalled();
	});

	it('acquires the deployment ownership lock before deleting only scoped cache roots', async () => {
		const systemConfig = await createSystemConfig();
		const { io } = createIo();
		const events: string[] = [];
		const acquireControllerOwnershipLock = vi.fn(async () => {
			events.push('lock');
			return { release: async () => void events.push('release') };
		});
		const removeDirectory = vi.fn(async (directoryPath: string) => {
			events.push(`remove:${directoryPath}`);
		});
		const deploymentCacheDir = deploymentCacheDirForSystemConfig(systemConfig);

		await runCacheCommand({ confirm: true, subcommand: 'clean', systemConfig }, io, {
			acquireControllerOwnershipLock,
			removeDirectory,
		});

		expect(acquireControllerOwnershipLock).toHaveBeenCalledWith({
			runtimeDirectory: systemConfig.controllerRuntimeDir,
		});
		expect(removeDirectory).toHaveBeenCalledTimes(2);
		expect(removeDirectory).toHaveBeenCalledWith(path.join(deploymentCacheDir, 'docker-contexts'));
		expect(removeDirectory).toHaveBeenCalledWith(path.join(deploymentCacheDir, 'zones'));
		expect(events[0]).toBe('lock');
		expect(events.at(-1)).toBe('release');
		expect(events.join('\n')).not.toContain(
			sharedImageCacheDirForStorageRoot(systemConfig.storageRootDir),
		);
		expect(events.join('\n')).not.toContain(
			deploymentGeneratedDirForStorageRoot(systemConfig.storageRootDir),
		);
	});

	it('does not delete when the controller ownership lock refuses admission', async () => {
		const systemConfig = await createSystemConfig();
		const { io } = createIo();
		const removeDirectory = vi.fn();

		await expect(
			runCacheCommand({ confirm: true, subcommand: 'clean', systemConfig }, io, {
				acquireControllerOwnershipLock: async () => {
					throw new Error('controller-already-active');
				},
				removeDirectory,
			}),
		).rejects.toThrow('controller-already-active');
		expect(removeDirectory).not.toHaveBeenCalled();
	});
});
