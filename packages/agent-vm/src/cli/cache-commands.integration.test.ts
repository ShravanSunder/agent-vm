import fs from 'node:fs/promises';
import { symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	createLoadedSystemConfig,
	deploymentCacheDirForSystemConfig,
	deploymentGeneratedDirForStorageRoot,
	sharedImageCacheDirForSystemConfig,
	type LoadedSystemConfig,
} from '../config/system-config.js';
import { acquireControllerOwnershipLock } from '../controller/vm-ownership/controller-ownership-lock.js';
import { runCacheCommand } from './cache-commands.js';

const temporaryDirectories: string[] = [];

async function createSystemConfig(
	root: string,
	deploymentName: string,
): Promise<LoadedSystemConfig> {
	const storageRootDir = path.join(root, deploymentName);
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
			host: { controllerPort: 18_800, projectNamespace: 'shared-namespace' },
			imageProfiles: {
				gateways: { worker: { buildConfig: buildConfigPath, type: 'worker' } },
				toolVms: { default: { buildConfig: buildConfigPath, type: 'toolVm' } },
			},
			zones: [
				{
					egressHosts: [{ audience: 'gateway', host: 'example.com' }],
					gateway: {
						config: path.join(root, 'worker.jsonc'),
						cpus: 1,
						imageProfile: 'worker',
						memory: '1G',
						port: 18_791,
						type: 'worker',
					},
					id: 'worker',
					secrets: {},
				},
			],
			toolVmProfiles: {
				standard: { cpus: 1, imageProfile: 'default', memory: '1G' },
			},
			tcpPool: { basePort: 19_000, size: 2 },
		},
		{ systemConfigPath: path.join(root, 'config', `${deploymentName}.jsonc`) },
	);
}

function createIo(): {
	readonly stderr: { write(): boolean };
	readonly stdout: { write(): boolean };
} {
	return {
		stderr: { write: () => true },
		stdout: { write: () => true },
	};
}

async function writeMarker(markerPath: string): Promise<void> {
	await fs.mkdir(path.dirname(markerPath), { recursive: true });
	await fs.writeFile(markerPath, 'preserve-or-delete\n', 'utf8');
}

async function pathExists(candidatePath: string): Promise<boolean> {
	try {
		await fs.access(candidatePath);
		return true;
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return false;
		}
		throw error;
	}
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map(async (directoryPath) => await fs.rm(directoryPath, { force: true, recursive: true })),
	);
});

describe('runCacheCommand filesystem boundaries', () => {
	it('refuses a cache ancestor symlink before deleting any target', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-cache-alias-'));
		temporaryDirectories.push(root);
		const systemConfig = await createSystemConfig(root, 'deployment');
		const deploymentCacheDir = deploymentCacheDirForSystemConfig(systemConfig);
		const dockerMarker = path.join(deploymentCacheDir, 'docker-contexts', 'preserve-on-refusal');
		const protectedMarker = path.join(root, 'durable', 'worker', 'framework-cache', 'protected');
		await Promise.all([writeMarker(dockerMarker), writeMarker(protectedMarker)]);
		await symlink(path.join(root, 'durable'), path.join(deploymentCacheDir, 'zones'));

		await expect(
			runCacheCommand({ confirm: true, subcommand: 'clean', systemConfig }, createIo()),
		).rejects.toThrow(/cache cleanup target/u);
		await expect(Promise.all([dockerMarker, protectedMarker].map(pathExists))).resolves.toEqual([
			true,
			true,
		]);
	});
	it('deletes only the invoking deployment cache scope and preserves shared and durable roots', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-cache-clean-integration-'));
		temporaryDirectories.push(root);
		const firstConfig = await createSystemConfig(root, 'deployment-a');
		const secondConfig = await createSystemConfig(root, 'deployment-b');
		const firstDeploymentCacheDir = deploymentCacheDirForSystemConfig(firstConfig);
		const secondDeploymentCacheDir = deploymentCacheDirForSystemConfig(secondConfig);
		const firstZone = firstConfig.zones[0];
		if (firstZone === undefined) throw new Error('Expected deployment test zone.');
		const deletedMarkers = [
			path.join(firstDeploymentCacheDir, 'docker-contexts', 'gateway', 'worker', 'context'),
			path.join(firstDeploymentCacheDir, 'zones', 'worker', 'framework-cache', 'cache-entry'),
			path.join(firstDeploymentCacheDir, 'zones', 'retired-zone', 'framework-cache', 'cache-entry'),
		];
		const preservedMarkers = [
			path.join(firstDeploymentCacheDir, 'zones', 'worker', 'preserve-me'),
			path.join(firstDeploymentCacheDir, 'zones', 'retired-zone', 'preserve-me'),
			path.join(secondDeploymentCacheDir, 'docker-contexts', 'gateway', 'worker', 'context'),
			path.join(secondDeploymentCacheDir, 'zones', 'worker', 'framework-cache', 'cache-entry'),
			path.join(
				sharedImageCacheDirForSystemConfig(firstConfig),
				'1111111111111111',
				'manifest.json',
			),
			path.join(
				deploymentGeneratedDirForStorageRoot(firstConfig.storageRootDir),
				'image-selections',
				'gateway',
				'worker.json',
			),
			path.join(firstZone.gateway.stateDir, 'durable-state'),
			path.join(firstConfig.storageRootDir, 'cache', 'legacy-cache-entry'),
		];
		await Promise.all([...deletedMarkers, ...preservedMarkers].map(writeMarker));

		await runCacheCommand(
			{ confirm: true, subcommand: 'clean', systemConfig: firstConfig },
			createIo(),
		);

		await expect(Promise.all(deletedMarkers.map(pathExists))).resolves.toEqual([
			false,
			false,
			false,
		]);
		await expect(Promise.all(preservedMarkers.map(pathExists))).resolves.toEqual(
			preservedMarkers.map(() => true),
		);
	});

	it('refuses cleanup while the deployment controller ownership lock is held', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-cache-lock-integration-'));
		temporaryDirectories.push(root);
		const systemConfig = await createSystemConfig(root, 'deployment');
		const deploymentCacheMarker = path.join(
			deploymentCacheDirForSystemConfig(systemConfig),
			'docker-contexts',
			'gateway',
			'worker',
			'context',
		);
		await writeMarker(deploymentCacheMarker);
		const controllerOwnershipLock = await acquireControllerOwnershipLock({
			runtimeDirectory: systemConfig.controllerRuntimeDir,
		});
		try {
			await expect(
				runCacheCommand({ confirm: true, subcommand: 'clean', systemConfig }, createIo()),
			).rejects.toMatchObject({ code: 'controller-already-active' });
			await expect(pathExists(deploymentCacheMarker)).resolves.toBe(true);
		} finally {
			await controllerOwnershipLock.release();
		}
	});
});
