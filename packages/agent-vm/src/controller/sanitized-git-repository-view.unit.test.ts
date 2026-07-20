import {
	access,
	chmod,
	link,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	type SanitizedGitRepositoryView,
	withSanitizedGitRepositoryView,
} from './sanitized-git-repository-view.js';

const selectedObjectId = '0123456789abcdef0123456789abcdef01234567';
const packObjectId = 'abcdef0123456789abcdef0123456789abcdef01';
const looseObjectDirectoryName = selectedObjectId.slice(0, 2);
const looseObjectFileName = selectedObjectId.slice(2);
const createdTemporaryRoots: string[] = [];

interface SyntheticRepositoryFixture {
	readonly outsideFilePath: string;
	readonly sourceGitDirectory: string;
	readonly workTreeDirectory: string;
}

async function createTemporaryRoot(): Promise<string> {
	const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-sanitized-git-view-unit-'));
	createdTemporaryRoots.push(temporaryRoot);
	return temporaryRoot;
}

async function createSyntheticRepositoryFixture(): Promise<SyntheticRepositoryFixture> {
	const temporaryRoot = await createTemporaryRoot();
	const sourceGitDirectory = path.join(temporaryRoot, 'source.git');
	const workTreeDirectory = path.join(temporaryRoot, 'workspace');
	const looseObjectDirectory = path.join(sourceGitDirectory, 'objects', looseObjectDirectoryName);
	const packDirectory = path.join(sourceGitDirectory, 'objects', 'pack');
	const outsideFilePath = path.join(temporaryRoot, 'outside-secret');
	await Promise.all([
		mkdir(looseObjectDirectory, { recursive: true }),
		mkdir(packDirectory, { recursive: true }),
		mkdir(path.join(sourceGitDirectory, 'objects', 'info'), { recursive: true }),
		mkdir(workTreeDirectory, { recursive: true }),
	]);
	await Promise.all([
		writeFile(path.join(looseObjectDirectory, looseObjectFileName), 'loose-object-bytes'),
		writeFile(path.join(packDirectory, `pack-${packObjectId}.pack`), 'pack-bytes'),
		writeFile(path.join(packDirectory, `pack-${packObjectId}.idx`), 'index-bytes'),
		writeFile(path.join(sourceGitDirectory, 'index'), 'workspace-index-bytes'),
		writeFile(path.join(sourceGitDirectory, 'config'), '[alias]\n\tpwn = !touch escaped\n'),
		writeFile(outsideFilePath, 'outside-secret-bytes'),
	]);
	return { outsideFilePath, sourceGitDirectory, workTreeDirectory };
}

function repositoryViewOptions(
	fixture: SyntheticRepositoryFixture,
): Parameters<typeof withSanitizedGitRepositoryView>[0] {
	return {
		index: { kind: 'copy-if-present' },
		selectedReference: {
			kind: 'branch',
			name: 'refs/heads/main',
			objectId: selectedObjectId,
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

describe('withSanitizedGitRepositoryView', () => {
	it('authors a private trusted view from only selected Git data', async () => {
		const fixture = await createSyntheticRepositoryFixture();
		let retainedViewRoot: string | undefined;

		const callbackResult = await withSanitizedGitRepositoryView(
			repositoryViewOptions(fixture),
			async (view): Promise<string> => {
				retainedViewRoot = view.rootDirectory;
				const rootStatus = await lstat(view.rootDirectory);
				const trustedConfig = await readFile(path.join(view.gitDirectory, 'config'), 'utf8');
				const copiedLooseObject = await readFile(
					path.join(view.gitDirectory, 'objects', looseObjectDirectoryName, looseObjectFileName),
					'utf8',
				);
				const copiedPack = await readFile(
					path.join(view.gitDirectory, 'objects', 'pack', `pack-${packObjectId}.pack`),
					'utf8',
				);

				expect(rootStatus.mode & 0o777).toBe(0o700);
				expect(trustedConfig).toContain('hooksPath = /dev/null');
				expect(trustedConfig).not.toContain('pwn');
				await expect(readFile(path.join(view.gitDirectory, 'HEAD'), 'utf8')).resolves.toBe(
					'ref: refs/heads/main\n',
				);
				await expect(
					readFile(path.join(view.gitDirectory, 'refs', 'heads', 'main'), 'utf8'),
				).resolves.toBe(`${selectedObjectId}\n`);
				await expect(readFile(path.join(view.gitDirectory, 'index'), 'utf8')).resolves.toBe(
					'workspace-index-bytes',
				);
				expect(copiedLooseObject).toBe('loose-object-bytes');
				expect(copiedPack).toBe('pack-bytes');
				expect(view.gitProcess).toEqual({
					argumentsPrefix: [
						`--git-dir=${view.gitDirectory}`,
						`--work-tree=${view.workTreeDirectory}`,
					],
					environment: {
						kind: 'replace',
						variables: {
							GIT_ASKPASS: '/usr/bin/false',
							GIT_CONFIG_GLOBAL: '/dev/null',
							GIT_CONFIG_NOSYSTEM: '1',
							GIT_CONFIG_SYSTEM: '/dev/null',
							GIT_EDITOR: '/usr/bin/false',
							GIT_PAGER: 'cat',
							GIT_SEQUENCE_EDITOR: '/usr/bin/false',
							GIT_SSH: '/usr/bin/false',
							GIT_SSH_COMMAND: '/usr/bin/false',
							GIT_TERMINAL_PROMPT: '0',
							HOME: path.join(view.rootDirectory, 'home'),
							LANG: 'C',
							LC_ALL: 'C',
							PAGER: 'cat',
							PATH: '/usr/bin:/bin',
							SSH_ASKPASS: '/usr/bin/false',
							XDG_CONFIG_HOME: path.join(view.rootDirectory, 'xdg-config'),
						},
					},
					executable: '/usr/bin/git',
				});
				return view.selectedReference.objectId;
			},
		);

		expect(callbackResult).toBe(selectedObjectId);
		if (retainedViewRoot === undefined) throw new Error('Expected callback to observe view root.');
		await expect(access(retainedViewRoot)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('omits the source index when the typed policy excludes it', async () => {
		const fixture = await createSyntheticRepositoryFixture();

		await withSanitizedGitRepositoryView(
			{ ...repositoryViewOptions(fixture), index: { kind: 'omit' } },
			async (view): Promise<void> => {
				await expect(access(path.join(view.gitDirectory, 'index'))).rejects.toMatchObject({
					code: 'ENOENT',
				});
			},
		);
	});

	it('cleans the view when the callback rejects', async () => {
		const fixture = await createSyntheticRepositoryFixture();
		const callbackError = new Error('operation rejected');
		let retainedView: SanitizedGitRepositoryView | undefined;

		await expect(
			withSanitizedGitRepositoryView(repositoryViewOptions(fixture), async (view) => {
				retainedView = view;
				throw callbackError;
			}),
		).rejects.toBe(callbackError);
		if (retainedView === undefined) throw new Error('Expected callback to observe view.');
		await expect(access(retainedView.rootDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it.each([
		['short object id', 'abc', 'refs/heads/main'],
		['unsafe reference traversal', selectedObjectId, 'refs/heads/../escape'],
		['reference lock suffix', selectedObjectId, 'refs/heads/main.lock'],
		['non-branch reference', selectedObjectId, 'refs/tags/main'],
	])('rejects %s before invoking the callback', async (_label, objectId, referenceName) => {
		const fixture = await createSyntheticRepositoryFixture();
		let callbackInvoked = false;

		await expect(
			withSanitizedGitRepositoryView(
				{
					...repositoryViewOptions(fixture),
					selectedReference: {
						kind: 'branch',
						name: referenceName,
						objectId,
					},
				},
				async (): Promise<void> => {
					callbackInvoked = true;
				},
			),
		).rejects.toThrow(/selected (?:object id|branch reference)/u);
		expect(callbackInvoked).toBe(false);
	});

	it.each(['commondir', 'gitdir', 'config.worktree', 'worktrees'])(
		'rejects linked-worktree authority marker %s',
		async (metadataName) => {
			const fixture = await createSyntheticRepositoryFixture();
			const metadataPath = path.join(fixture.sourceGitDirectory, metadataName);
			if (metadataName === 'worktrees') {
				await mkdir(metadataPath);
			} else {
				await writeFile(metadataPath, 'hostile metadata');
			}

			await expect(
				withSanitizedGitRepositoryView(
					repositoryViewOptions(fixture),
					async (): Promise<void> => undefined,
				),
			).rejects.toThrow(/linked-worktree metadata/u);
		},
	);

	it.each(['alternates', 'http-alternates'])(
		'rejects object indirection through %s',
		async (alternatesName) => {
			const fixture = await createSyntheticRepositoryFixture();
			await writeFile(
				path.join(fixture.sourceGitDirectory, 'objects', 'info', alternatesName),
				fixture.outsideFilePath,
			);

			await expect(
				withSanitizedGitRepositoryView(
					repositoryViewOptions(fixture),
					async (): Promise<void> => undefined,
				),
			).rejects.toThrow(/object alternate/u);
		},
	);

	it('rejects a symlink in selected object storage', async () => {
		const fixture = await createSyntheticRepositoryFixture();
		const looseObjectPath = path.join(
			fixture.sourceGitDirectory,
			'objects',
			looseObjectDirectoryName,
			looseObjectFileName,
		);
		await rm(looseObjectPath);
		await symlink(fixture.outsideFilePath, looseObjectPath);

		await expect(
			withSanitizedGitRepositoryView(
				repositoryViewOptions(fixture),
				async (): Promise<void> => undefined,
			),
		).rejects.toThrow(/symbolic link/u);
	});

	it('rejects a hard-linked regular object', async () => {
		const fixture = await createSyntheticRepositoryFixture();
		const looseObjectPath = path.join(
			fixture.sourceGitDirectory,
			'objects',
			looseObjectDirectoryName,
			looseObjectFileName,
		);
		await chmod(fixture.outsideFilePath, 0o600);
		await rm(looseObjectPath);
		await link(fixture.outsideFilePath, looseObjectPath);

		await expect(
			withSanitizedGitRepositoryView(
				repositoryViewOptions(fixture),
				async (): Promise<void> => undefined,
			),
		).rejects.toThrow(/hard-linked/u);
	});

	it('rejects source Git root replacement before callback authority', async () => {
		const fixture = await createSyntheticRepositoryFixture();
		const outsideFixture = await createSyntheticRepositoryFixture();
		const canonicalSourceGitDirectory = await realpath(fixture.sourceGitDirectory);
		const canonicalObjectsDirectory = path.join(canonicalSourceGitDirectory, 'objects');
		const preservedSourceGitDirectory = path.join(
			path.dirname(fixture.sourceGitDirectory),
			'preserved-source.git',
		);
		let sourceRootReplaced = false;
		let callbackInvoked = false;

		await expect(
			withSanitizedGitRepositoryView(
				repositoryViewOptions(fixture),
				async (): Promise<void> => {
					callbackInvoked = true;
				},
				{
					afterSourceDirectoryRead: async (directoryPath): Promise<void> => {
						if (directoryPath !== canonicalObjectsDirectory || sourceRootReplaced) return;
						sourceRootReplaced = true;
						await rename(fixture.sourceGitDirectory, preservedSourceGitDirectory);
						await symlink(outsideFixture.sourceGitDirectory, fixture.sourceGitDirectory, 'dir');
					},
				},
			),
		).rejects.toThrow(/source Git directory authority changed/iu);
		expect(sourceRootReplaced).toBe(true);
		expect(callbackInvoked).toBe(false);
	});
});
