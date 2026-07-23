import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	materializeManagedAgentGitDirectoryRoot,
	materializeManagedAgentRootStorage,
	resolveManagedAgentGitDirectoryRoot,
	resolveManagedAgentRootPaths,
} from './managed-agent-root-storage.js';

describe('managed agent root storage', () => {
	const temporaryRoots: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temporaryRoots.splice(0).map(async (temporaryRoot) => {
				await rm(temporaryRoot, { force: true, recursive: true });
			}),
		);
	});

	async function createStorageRoots(): Promise<{
		readonly controllerStateDir: string;
		readonly zoneRuntimeDir: string;
		readonly stateDir: string;
		readonly temporaryRoot: string;
		readonly zoneFilesDir: string;
	}> {
		const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'managed-agent-roots-'));
		temporaryRoots.push(temporaryRoot);
		return {
			controllerStateDir: path.join(temporaryRoot, 'controller-state'),
			zoneRuntimeDir: path.join(temporaryRoot, 'runtime'),
			stateDir: path.join(temporaryRoot, 'state'),
			temporaryRoot,
			zoneFilesDir: path.join(temporaryRoot, 'zone-files'),
		};
	}

	it('materializes one controller-derived writable Git directory root per zone agent', async () => {
		const roots = await createStorageRoots();
		await mkdir(roots.zoneRuntimeDir, { recursive: true });
		await chmod(roots.zoneRuntimeDir, 0o755);
		const runtimeModeBeforeMaterialization = (await lstat(roots.zoneRuntimeDir)).mode & 0o777;

		const hostGitDirectoryRoot = await materializeManagedAgentGitDirectoryRoot({
			agentId: 'alpha',
			zoneRuntimeDir: roots.zoneRuntimeDir,
		});

		expect(hostGitDirectoryRoot).toBe(
			await realpath(path.join(roots.zoneRuntimeDir, 'gitdirs', 'agents', 'alpha')),
		);
		expect((await lstat(hostGitDirectoryRoot)).mode & 0o777).toBe(0o700);
		expect((await lstat(roots.zoneRuntimeDir)).mode & 0o777).toBe(runtimeModeBeforeMaterialization);
		expect(
			resolveManagedAgentGitDirectoryRoot({
				agentId: 'alpha',
				zoneRuntimeDir: roots.zoneRuntimeDir,
			}),
		).toBe(path.join(roots.zoneRuntimeDir, 'gitdirs', 'agents', 'alpha'));
	});

	it('materializes concurrent agent Git roots through shared zone ancestors', async () => {
		const roots = await createStorageRoots();
		await mkdir(roots.zoneRuntimeDir, { recursive: true });

		const [alphaGitDirectoryRoot, betaGitDirectoryRoot] = await Promise.all([
			materializeManagedAgentGitDirectoryRoot({
				agentId: 'alpha',
				zoneRuntimeDir: roots.zoneRuntimeDir,
			}),
			materializeManagedAgentGitDirectoryRoot({
				agentId: 'beta',
				zoneRuntimeDir: roots.zoneRuntimeDir,
			}),
		]);

		expect(alphaGitDirectoryRoot).toBe(
			await realpath(path.join(roots.zoneRuntimeDir, 'gitdirs', 'agents', 'alpha')),
		);
		expect(betaGitDirectoryRoot).toBe(
			await realpath(path.join(roots.zoneRuntimeDir, 'gitdirs', 'agents', 'beta')),
		);
	});

	it('materializes one deterministic framework-neutral workspace per agent', async () => {
		const roots = await createStorageRoots();

		const materialized = await materializeManagedAgentRootStorage({
			agentIds: ['beta', 'alpha'],
			controllerStateDir: roots.controllerStateDir,
			stateDir: roots.stateDir,
			zoneFilesDir: roots.zoneFilesDir,
		});

		expect(materialized.map((projection) => projection.agentId)).toEqual(['alpha', 'beta']);
		const alphaRoots = materialized[0];
		if (alphaRoots === undefined) {
			throw new Error('Expected materialized alpha roots.');
		}
		expect(alphaRoots).toEqual({
			agentId: 'alpha',
			gatewayWorkspaceRoot: '/zone/agents/alpha',
			hostWorkspaceRoot: await realpath(path.join(roots.zoneFilesDir, 'agents', 'alpha')),
		});
		expect((await lstat(alphaRoots.hostWorkspaceRoot)).mode & 0o777).toBe(0o700);
		await expect(readFile(path.join(roots.stateDir, 'agents', 'alpha'), 'utf8')).rejects.toThrow();
		await expect(
			readFile(path.join(roots.controllerStateDir, 'agents', 'alpha'), 'utf8'),
		).rejects.toThrow();
	});

	it('rejects duplicate, traversal-shaped, and separator-bearing agent ids', async () => {
		const roots = await createStorageRoots();

		await expect(
			materializeManagedAgentRootStorage({
				agentIds: ['alpha', 'alpha'],
				controllerStateDir: roots.controllerStateDir,
				stateDir: roots.stateDir,
				zoneFilesDir: roots.zoneFilesDir,
			}),
		).rejects.toThrow(/duplicate/u);
		for (const agentId of ['../other', 'alpha/beta', 'alpha\\beta']) {
			expect(() =>
				resolveManagedAgentRootPaths({ agentId, zoneFilesDir: roots.zoneFilesDir }),
			).toThrow(/agent id/u);
		}
	});

	it('rejects storage overlap before creating agent roots', async () => {
		const roots = await createStorageRoots();

		await expect(
			materializeManagedAgentRootStorage({
				agentIds: ['alpha'],
				controllerStateDir: path.join(roots.zoneFilesDir, 'controller-state'),
				stateDir: roots.stateDir,
				zoneFilesDir: roots.zoneFilesDir,
			}),
		).rejects.toThrow(/controllerStateDir.*zoneFilesDir/u);
		await expect(
			materializeManagedAgentRootStorage({
				agentIds: ['alpha'],
				controllerStateDir: roots.controllerStateDir,
				stateDir: roots.zoneFilesDir,
				zoneFilesDir: path.join(roots.zoneFilesDir, 'nested-zone-files'),
			}),
		).rejects.toThrow(/stateDir.*zoneFilesDir/u);
	});

	it('rejects canonical aliases across every storage root with missing descendants', async () => {
		const roots = await createStorageRoots();
		await mkdir(roots.controllerStateDir);
		await mkdir(roots.stateDir);
		await mkdir(roots.zoneFilesDir);
		const controllerStateAlias = path.join(roots.temporaryRoot, 'controller-state-alias');
		const stateAlias = path.join(roots.temporaryRoot, 'state-alias');
		const zoneFilesAlias = path.join(roots.temporaryRoot, 'zone-files-alias');
		await symlink(roots.controllerStateDir, controllerStateAlias, 'dir');
		await symlink(roots.stateDir, stateAlias, 'dir');
		await symlink(roots.zoneFilesDir, zoneFilesAlias, 'dir');

		const aliasCases = [
			{
				controllerStateDir: roots.controllerStateDir,
				expectedError: /stateDir.*zoneFilesDir/u,
				stateDir: roots.stateDir,
				zoneFilesDir: path.join(stateAlias, 'missing-zone-files'),
			},
			{
				controllerStateDir: path.join(zoneFilesAlias, 'missing-controller-state'),
				expectedError: /controllerStateDir.*zoneFilesDir/u,
				stateDir: roots.stateDir,
				zoneFilesDir: roots.zoneFilesDir,
			},
			{
				controllerStateDir: roots.controllerStateDir,
				expectedError: /controllerStateDir.*stateDir/u,
				stateDir: path.join(controllerStateAlias, 'missing-state'),
				zoneFilesDir: roots.zoneFilesDir,
			},
		] as const;
		for (const aliasCase of aliasCases) {
			// oxlint-disable-next-line no-await-in-loop -- each canonical alias owns an independent fail-closed assertion.
			await expect(
				materializeManagedAgentRootStorage({
					agentIds: ['alpha'],
					controllerStateDir: aliasCase.controllerStateDir,
					stateDir: aliasCase.stateDir,
					zoneFilesDir: aliasCase.zoneFilesDir,
				}),
			).rejects.toThrow(aliasCase.expectedError);
		}
	});

	it('rejects a pre-existing symlink at an agent-owned root boundary', async () => {
		const roots = await createStorageRoots();
		const outsideDirectory = path.join(roots.temporaryRoot, 'outside');
		const agentRoot = path.join(roots.zoneFilesDir, 'agents', 'alpha');
		await materializeManagedAgentRootStorage({
			agentIds: [],
			controllerStateDir: roots.controllerStateDir,
			stateDir: roots.stateDir,
			zoneFilesDir: roots.zoneFilesDir,
		});
		await symlink(outsideDirectory, agentRoot, 'dir');

		await expect(
			materializeManagedAgentRootStorage({
				agentIds: ['alpha'],
				controllerStateDir: roots.controllerStateDir,
				stateDir: roots.stateDir,
				zoneFilesDir: roots.zoneFilesDir,
			}),
		).rejects.toThrow(/real directory/u);
	});
});
