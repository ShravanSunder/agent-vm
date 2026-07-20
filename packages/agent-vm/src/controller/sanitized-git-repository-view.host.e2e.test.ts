import {
	access,
	chmod,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import {
	type SanitizedGitRepositoryView,
	withSanitizedGitRepositoryView,
} from './sanitized-git-repository-view.js';

const createdTemporaryRoots: string[] = [];

interface RealRepositoryFixture {
	readonly headObjectId: string;
	readonly sourceGitDirectory: string;
	readonly temporaryRoot: string;
	readonly workTreeDirectory: string;
}

async function runGit(
	argumentsList: readonly string[],
	options: { readonly cwd?: string; readonly view?: SanitizedGitRepositoryView } = {},
): Promise<string> {
	const invocationArguments =
		options.view === undefined
			? [...argumentsList]
			: [...options.view.gitProcess.argumentsPrefix, ...argumentsList];
	const result = await execa(
		options.view?.gitProcess.executable ?? '/usr/bin/git',
		invocationArguments,
		options.view === undefined
			? options.cwd === undefined
				? {}
				: { cwd: options.cwd }
			: {
					cwd: options.view.workTreeDirectory,
					env: { ...options.view.gitProcess.environment.variables },
					extendEnv: false,
				},
	);
	return result.stdout.trim();
}

async function createRealRepositoryFixture(): Promise<RealRepositoryFixture> {
	const temporaryRoot = await mkdtemp(
		path.join(os.tmpdir(), 'agent-vm-sanitized-git-view-host-e2e-'),
	);
	createdTemporaryRoots.push(temporaryRoot);
	const workTreeDirectory = path.join(temporaryRoot, 'workspace');
	await mkdir(workTreeDirectory);
	await runGit(['init', '--initial-branch=main'], { cwd: workTreeDirectory });
	await runGit(['config', 'user.email', 'controller-test@example.com'], {
		cwd: workTreeDirectory,
	});
	await runGit(['config', 'user.name', 'Controller Test'], { cwd: workTreeDirectory });
	await runGit(['config', 'commit.gpgsign', 'false'], { cwd: workTreeDirectory });
	await writeFile(path.join(workTreeDirectory, 'README.md'), 'trusted content\n');
	await runGit(['add', 'README.md'], { cwd: workTreeDirectory });
	await runGit(['commit', '-m', 'initial'], { cwd: workTreeDirectory });
	const headObjectId = await runGit(['rev-parse', 'HEAD'], { cwd: workTreeDirectory });
	await runGit(['gc', '--prune=now'], { cwd: workTreeDirectory });
	return {
		headObjectId,
		sourceGitDirectory: path.join(workTreeDirectory, '.git'),
		temporaryRoot,
		workTreeDirectory,
	};
}

function repositoryViewOptions(
	fixture: RealRepositoryFixture,
): Parameters<typeof withSanitizedGitRepositoryView>[0] {
	return {
		index: { kind: 'copy-if-present' },
		selectedReference: {
			kind: 'branch',
			name: 'refs/heads/main',
			objectId: fixture.headObjectId,
		},
		sourceGitDirectory: fixture.sourceGitDirectory,
		workTreeDirectory: fixture.workTreeDirectory,
	};
}

afterEach(async () => {
	await Promise.all(
		createdTemporaryRoots
			.splice(0)
			.map(async (temporaryRoot) => await rm(temporaryRoot, { force: true, recursive: true })),
	);
});

describe('sanitized Git repository view host boundary', () => {
	it('ignores hostile local, included, global, hook, diff-driver, and ambient execution config', async () => {
		const fixture = await createRealRepositoryFixture();
		const hostileDirectory = path.join(fixture.temporaryRoot, 'hostile');
		const hostileHooksDirectory = path.join(hostileDirectory, 'hooks');
		const includedConfigPath = path.join(hostileDirectory, 'included.config');
		const hostileGlobalConfigPath = path.join(hostileDirectory, 'global.config');
		const aliasMarkerPath = path.join(hostileDirectory, 'alias-executed');
		const ambientAliasMarkerPath = path.join(hostileDirectory, 'ambient-alias-executed');
		const injectedAliasMarkerPath = path.join(hostileDirectory, 'injected-alias-executed');
		const hookMarkerPath = path.join(hostileDirectory, 'hook-executed');
		const diffMarkerPath = path.join(hostileDirectory, 'diff-driver-executed');
		await mkdir(hostileHooksDirectory, { recursive: true });
		const referenceHookPath = path.join(hostileHooksDirectory, 'reference-transaction');
		await writeFile(referenceHookPath, `#!/bin/sh\ntouch '${hookMarkerPath}'\n`);
		await chmod(referenceHookPath, 0o700);
		await runGit([
			'config',
			'--file',
			includedConfigPath,
			'alias.pwn',
			`!touch '${aliasMarkerPath}'`,
		]);
		await runGit(['config', '--file', includedConfigPath, 'core.hooksPath', hostileHooksDirectory]);
		await runGit([
			'config',
			'--file',
			includedConfigPath,
			'diff.hostile.command',
			`touch '${diffMarkerPath}'`,
		]);
		await runGit([
			'config',
			'--file',
			hostileGlobalConfigPath,
			'alias.ambient',
			`!touch '${ambientAliasMarkerPath}'`,
		]);
		await runGit([
			'config',
			'--file',
			path.join(fixture.sourceGitDirectory, 'config'),
			'include.path',
			includedConfigPath,
		]);
		await writeFile(path.join(fixture.workTreeDirectory, '.gitattributes'), '* diff=hostile\n');
		await writeFile(path.join(fixture.workTreeDirectory, 'README.md'), 'untrusted edit\n');
		const hostileAmbientVariableNames = [
			'GIT_CONFIG_GLOBAL',
			'GIT_CONFIG_COUNT',
			'GIT_CONFIG_KEY_0',
			'GIT_CONFIG_VALUE_0',
		] as const;
		const previousAmbientVariables = hostileAmbientVariableNames.map((variableName) => ({
			value: process.env[variableName],
			variableName,
		}));
		process.env.GIT_CONFIG_GLOBAL = hostileGlobalConfigPath;
		process.env.GIT_CONFIG_COUNT = '1';
		process.env.GIT_CONFIG_KEY_0 = 'alias.injected';
		process.env.GIT_CONFIG_VALUE_0 = `!touch '${injectedAliasMarkerPath}'`;
		try {
			await withSanitizedGitRepositoryView(
				repositoryViewOptions(fixture),
				async (view): Promise<void> => {
					expect(view.gitProcess.environment.kind).toBe('replace');
					expect(view.gitProcess.environment.variables).not.toHaveProperty('GIT_CONFIG_COUNT');
					expect(view.gitProcess.environment.variables.GIT_CONFIG_GLOBAL).toBe('/dev/null');
					await expect(runGit(['rev-parse', 'HEAD'], { view })).resolves.toBe(fixture.headObjectId);
					await expect(runGit(['pwn'], { view })).rejects.toMatchObject({ exitCode: 1 });
					await expect(runGit(['ambient'], { view })).rejects.toMatchObject({ exitCode: 1 });
					await expect(runGit(['injected'], { view })).rejects.toMatchObject({ exitCode: 1 });
					await expect(runGit(['diff', '--', 'README.md'], { view })).resolves.toContain(
						'untrusted edit',
					);
					await runGit(['update-ref', 'refs/heads/controller-probe', fixture.headObjectId], {
						view,
					});
				},
			);
		} finally {
			for (const { value, variableName } of previousAmbientVariables) {
				if (value === undefined) {
					delete process.env[variableName];
				} else {
					process.env[variableName] = value;
				}
			}
		}

		await Promise.all(
			[
				aliasMarkerPath,
				ambientAliasMarkerPath,
				injectedAliasMarkerPath,
				hookMarkerPath,
				diffMarkerPath,
			].map(
				async (markerPath) =>
					await expect(access(markerPath)).rejects.toMatchObject({ code: 'ENOENT' }),
			),
		);
	});

	it('rejects an alternate object directory instead of importing its authority', async () => {
		const fixture = await createRealRepositoryFixture();
		const alternateObjectsDirectory = path.join(fixture.temporaryRoot, 'outside-objects');
		await mkdir(alternateObjectsDirectory);
		await writeFile(
			path.join(fixture.sourceGitDirectory, 'objects', 'info', 'alternates'),
			`${alternateObjectsDirectory}\n`,
		);
		let callbackInvoked = false;

		await expect(
			withSanitizedGitRepositoryView(repositoryViewOptions(fixture), async (): Promise<void> => {
				callbackInvoked = true;
			}),
		).rejects.toThrow(/object alternate/u);
		expect(callbackInvoked).toBe(false);
	});

	it('rejects an object symlink instead of copying bytes outside the Git database', async () => {
		const fixture = await createRealRepositoryFixture();
		const outsideFilePath = path.join(fixture.temporaryRoot, 'outside-secret');
		const looseObjectDirectory = path.join(fixture.sourceGitDirectory, 'objects', 'ee');
		await writeFile(outsideFilePath, 'outside bytes');
		await mkdir(looseObjectDirectory);
		await symlink(outsideFilePath, path.join(looseObjectDirectory, 'e'.repeat(38)));

		await expect(
			withSanitizedGitRepositoryView(
				repositoryViewOptions(fixture),
				async (): Promise<void> => undefined,
			),
		).rejects.toThrow(/symbolic link/u);
	});

	it('rejects a special object file instead of copying it into controller authority', async () => {
		const fixture = await createRealRepositoryFixture();
		const looseObjectDirectory = path.join(fixture.sourceGitDirectory, 'objects', 'ff');
		const fifoObjectPath = path.join(looseObjectDirectory, 'f'.repeat(38));
		await mkdir(looseObjectDirectory);
		await execa('/usr/bin/mkfifo', [fifoObjectPath]);

		await expect(
			withSanitizedGitRepositoryView(
				repositoryViewOptions(fixture),
				async (): Promise<void> => undefined,
			),
		).rejects.toThrow(/regular file/u);
	});

	it('rejects an intermediate pack-directory swap before outside bytes enter callback authority', async () => {
		const fixture = await createRealRepositoryFixture();
		const sourcePackDirectory = path.join(fixture.sourceGitDirectory, 'objects', 'pack');
		const canonicalSourcePackDirectory = await realpath(sourcePackDirectory);
		const preservedPackDirectory = path.join(fixture.temporaryRoot, 'preserved-pack');
		const outsidePackDirectory = path.join(fixture.temporaryRoot, 'outside-pack');
		await cp(sourcePackDirectory, outsidePackDirectory, { recursive: true });
		const outsidePackFileName = (await readdir(outsidePackDirectory)).find((fileName) =>
			fileName.endsWith('.pack'),
		);
		if (outsidePackFileName === undefined) throw new Error('Expected packed repository fixture.');
		const outsideSentinelBytes = 'outside-cross-agent-pack-sentinel';
		const outsidePackFilePath = path.join(outsidePackDirectory, outsidePackFileName);
		await chmod(outsidePackFilePath, 0o600);
		await writeFile(outsidePackFilePath, outsideSentinelBytes);
		let callbackInvoked = false;
		let outsideBytesObserved = false;
		let packDirectorySwapped = false;

		await expect(
			withSanitizedGitRepositoryView(
				repositoryViewOptions(fixture),
				async (view): Promise<void> => {
					callbackInvoked = true;
					const copiedPackBytes = await readFile(
						path.join(view.gitDirectory, 'objects', 'pack', outsidePackFileName),
						'utf8',
					);
					outsideBytesObserved = copiedPackBytes === outsideSentinelBytes;
				},
				{
					afterSourceDirectoryRead: async (directoryPath): Promise<void> => {
						if (directoryPath !== canonicalSourcePackDirectory || packDirectorySwapped) return;
						packDirectorySwapped = true;
						await rename(sourcePackDirectory, preservedPackDirectory);
						await symlink(outsidePackDirectory, sourcePackDirectory, 'dir');
					},
				},
			),
		).rejects.toThrow(/source Git directory authority|escaped.*source Git directory/iu);
		expect(packDirectorySwapped).toBe(true);
		expect(callbackInvoked).toBe(false);
		expect(outsideBytesObserved).toBe(false);
	});
});
