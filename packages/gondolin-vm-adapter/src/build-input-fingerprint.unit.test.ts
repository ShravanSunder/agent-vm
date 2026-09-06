import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { computeEffectiveBuildFingerprint } from './build-pipeline.js';

const temporaryDirectories: string[] = [];
afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map(async (directory) => await rm(directory, { recursive: true, force: true })),
	);
});

describe('content-complete build fingerprints', () => {
	it('hashes copied links by link text without traversing cyclic or dangling targets', async () => {
		const configDir = await mkdtemp(path.join(os.tmpdir(), 'build-links-fingerprint-'));
		temporaryDirectories.push(configDir);
		await mkdir(path.join(configDir, 'tree'));
		await writeFile(path.join(configDir, 'external'), 'first');
		await symlink('../external', path.join(configDir, 'tree', 'external-link'));
		await symlink('.', path.join(configDir, 'tree', 'loop'));
		await symlink('missing', path.join(configDir, 'tree', 'dangling'));
		const options = {
			buildConfig: {
				arch: 'aarch64',
				distro: 'alpine',
				postBuild: { copy: [{ src: './tree', dest: '/tree' }] },
			},
			configDir,
		} as const;
		const fingerprint = async (): Promise<string> =>
			(
				await computeEffectiveBuildFingerprint({
					...options,
					buildConfig: {
						...options.buildConfig,
						postBuild: { copy: [...options.buildConfig.postBuild.copy] },
					},
				})
			).fingerprint;
		const initial = await fingerprint();
		await writeFile(path.join(configDir, 'external'), 'second');

		expect(await fingerprint()).toBe(initial);
		await rm(path.join(configDir, 'tree', 'dangling'));
		await symlink('different', path.join(configDir, 'tree', 'dangling'));
		expect(await fingerprint()).not.toBe(initial);
	});
	it('distinguishes referenced bytes and mode while ignoring recipe-root placement', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'build-input-fingerprint-'));
		temporaryDirectories.push(root);
		const firstRoot = path.join(root, 'first');
		const secondRoot = path.join(root, 'second');
		await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
		await Promise.all([
			writeFile(path.join(firstRoot, 'input'), 'first'),
			writeFile(path.join(secondRoot, 'input'), 'second'),
		]);
		const buildConfig = {
			arch: 'aarch64',
			distro: 'alpine',
			postBuild: { copy: [{ src: './input', dest: '/input' }] },
		} as const;
		const fingerprint = async (configDir: string): Promise<string> =>
			(
				await computeEffectiveBuildFingerprint({
					buildConfig: { ...buildConfig, postBuild: { copy: [...buildConfig.postBuild.copy] } },
					configDir,
					gondolinVersion: 'test',
				})
			).fingerprint;

		const firstFingerprint = await fingerprint(firstRoot);
		expect(await fingerprint(secondRoot)).not.toBe(firstFingerprint);
		await writeFile(path.join(secondRoot, 'input'), 'first');
		expect(await fingerprint(secondRoot)).toBe(firstFingerprint);
		await chmod(path.join(secondRoot, 'input'), 0o755);
		expect(await fingerprint(secondRoot)).not.toBe(firstFingerprint);
	});
	it.each(['rootfsInit', 'initramfsInit', 'rootfsInitExtra'] as const)(
		'includes %s file content',
		async (inputKind) => {
			const configDir = await mkdtemp(path.join(os.tmpdir(), 'build-init-fingerprint-'));
			temporaryDirectories.push(configDir);
			await writeFile(path.join(configDir, 'init.sh'), 'first');
			const options = {
				buildConfig: { arch: 'aarch64', distro: 'alpine', init: { [inputKind]: './init.sh' } },
				configDir,
				gondolinVersion: 'test',
			} as const;
			const first = await computeEffectiveBuildFingerprint(options);
			await writeFile(path.join(configDir, 'init.sh'), 'second');

			expect((await computeEffectiveBuildFingerprint(options)).fingerprint).not.toBe(
				first.fingerprint,
			);
		},
	);
	it('includes copied directory contents and all explicit helper bytes', async () => {
		const configDir = await mkdtemp(path.join(os.tmpdir(), 'build-tree-fingerprint-'));
		temporaryDirectories.push(configDir);
		await mkdir(path.join(configDir, 'tree'));
		await writeFile(path.join(configDir, 'tree', 'child'), 'first');
		const helpers = {
			sandboxdPath: './sandboxd',
			sandboxfsPath: './sandboxfs',
			sandboxsshPath: './sandboxssh',
			sandboxingressPath: './sandboxingress',
		};
		await Promise.all(
			Object.values(helpers).map(
				async (fileName) => await writeFile(path.join(configDir, fileName), 'helper'),
			),
		);
		const options = {
			buildConfig: {
				arch: 'aarch64' as const,
				distro: 'alpine' as const,
				...helpers,
				postBuild: { copy: [{ src: './tree', dest: '/tree' }] },
			},
			configDir,
			gondolinVersion: 'test',
		};
		const first = await computeEffectiveBuildFingerprint(options);
		await writeFile(path.join(configDir, 'tree', 'child'), 'second');
		const changedTree = await computeEffectiveBuildFingerprint(options);
		await writeFile(path.join(configDir, 'sandboxssh'), 'changed-helper');

		expect(changedTree.fingerprint).not.toBe(first.fingerprint);
		expect((await computeEffectiveBuildFingerprint(options)).fingerprint).not.toBe(
			changedTree.fingerprint,
		);
	});
});
