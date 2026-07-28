import { constants, type Dirent, type Stats } from 'node:fs';
import {
	chmod,
	type FileHandle,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const trustedGitExecutable = '/usr/bin/git' as const;
const disabledExecutable = '/usr/bin/false' as const;
const gitObjectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const looseObjectDirectoryPattern = /^[0-9a-f]{2}$/u;
const looseObjectFilePattern = /^(?:[0-9a-f]{38}|[0-9a-f]{62})$/u;
const packFilePattern = /^pack-([0-9a-f]{40}|[0-9a-f]{64})\.(idx|pack)$/u;
const linkedWorktreeMetadataNames = [
	'commondir',
	'config.worktree',
	'gitdir',
	'worktrees',
] as const;
const objectAlternateNames = ['alternates', 'http-alternates'] as const;
const trustedRepositoryConfig = [
	'[core]',
	'\trepositoryFormatVersion = 0',
	'\tbare = false',
	'\thooksPath = /dev/null',
	'\tfsmonitor = false',
	'\texcludesFile = /dev/null',
	'\tpager = cat',
	'[credential]',
	'\thelper =',
	'[commit]',
	'\tgpgSign = false',
	'[tag]',
	'\tgpgSign = false',
	'[protocol]',
	'\tallow = never',
	'',
].join('\n');

export interface SanitizedGitSelectedBranch {
	readonly kind: 'branch';
	readonly name: string;
	readonly objectId: string;
}

export type SanitizedGitIndexPolicy =
	| { readonly kind: 'copy-if-present' }
	| { readonly kind: 'omit' };

export interface SanitizedGitRepositoryViewOptions {
	readonly index: SanitizedGitIndexPolicy;
	readonly selectedReference: SanitizedGitSelectedBranch;
	readonly sourceGitDirectory: string;
	readonly workTreeDirectory: string;
}

export interface SanitizedGitRepositoryViewDependencies {
	readonly afterSourceDirectoryRead?: (directoryPath: string) => Promise<void>;
}

export interface SanitizedGitProcessEnvironment {
	readonly GIT_ASKPASS: typeof disabledExecutable;
	readonly GIT_CONFIG_GLOBAL: '/dev/null';
	readonly GIT_CONFIG_NOSYSTEM: '1';
	readonly GIT_CONFIG_SYSTEM: '/dev/null';
	readonly GIT_EDITOR: typeof disabledExecutable;
	readonly GIT_PAGER: 'cat';
	readonly GIT_SEQUENCE_EDITOR: typeof disabledExecutable;
	readonly GIT_SSH: typeof disabledExecutable;
	readonly GIT_SSH_COMMAND: typeof disabledExecutable;
	readonly GIT_TERMINAL_PROMPT: '0';
	readonly HOME: string;
	readonly LANG: 'C';
	readonly LC_ALL: 'C';
	readonly PAGER: 'cat';
	readonly PATH: '/usr/bin:/bin';
	readonly SSH_ASKPASS: typeof disabledExecutable;
	readonly XDG_CONFIG_HOME: string;
}

export interface SanitizedGitProcessContract {
	readonly argumentsPrefix: readonly string[];
	readonly environment: {
		readonly kind: 'replace';
		readonly variables: SanitizedGitProcessEnvironment;
	};
	readonly executable: typeof trustedGitExecutable;
}

export interface SanitizedGitRepositoryView {
	readonly gitDirectory: string;
	readonly gitProcess: SanitizedGitProcessContract;
	readonly kind: 'sanitized-git-repository-view';
	readonly rootDirectory: string;
	readonly selectedReference: SanitizedGitSelectedBranch;
	readonly workTreeDirectory: string;
}

interface SourceGitRootSelection {
	readonly canonicalPath: string;
	readonly identity: SourcePathIdentity;
}

interface SourceGitRootAuthority extends SourceGitRootSelection {
	readonly directoryHandle: FileHandle;
}

interface SourcePathIdentity {
	readonly device: number;
	readonly inode: number;
}

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && 'code' in error && typeof error.code === 'string'
		? error.code
		: undefined;
}

async function readOptionalPathStatus(filePath: string): Promise<Stats | undefined> {
	try {
		return await lstat(filePath);
	} catch (error) {
		if (errorCode(error) === 'ENOENT') return undefined;
		throw error;
	}
}

async function resolveRealDirectory(directoryPath: string, label: string): Promise<string> {
	const resolvedPath = path.resolve(directoryPath);
	const status = await lstat(resolvedPath);
	if (status.isSymbolicLink()) {
		throw new Error(`${label} '${directoryPath}' must not be a symbolic link.`);
	}
	if (!status.isDirectory()) {
		throw new Error(`${label} '${directoryPath}' must be a real directory.`);
	}
	return await realpath(resolvedPath);
}

function sourcePathIdentity(status: Stats): SourcePathIdentity {
	return { device: status.dev, inode: status.ino };
}

function sourcePathIdentitiesEqual(
	leftIdentity: SourcePathIdentity,
	rightIdentity: SourcePathIdentity,
): boolean {
	return leftIdentity.device === rightIdentity.device && leftIdentity.inode === rightIdentity.inode;
}

async function resolveSourceGitRootSelection(
	sourceGitDirectory: string,
): Promise<SourceGitRootSelection> {
	const resolvedPath = path.resolve(sourceGitDirectory);
	const selectedPathStatus = await lstat(resolvedPath);
	if (selectedPathStatus.isSymbolicLink()) {
		throw new Error(`Source Git directory '${sourceGitDirectory}' must not be a symbolic link.`);
	}
	if (!selectedPathStatus.isDirectory()) {
		throw new Error(`Source Git directory '${sourceGitDirectory}' must be a real directory.`);
	}
	const canonicalPath = await realpath(resolvedPath);
	const canonicalPathStatus = await lstat(canonicalPath);
	if (
		!canonicalPathStatus.isDirectory() ||
		!sourcePathIdentitiesEqual(
			sourcePathIdentity(selectedPathStatus),
			sourcePathIdentity(canonicalPathStatus),
		)
	) {
		throw new Error('Source Git directory identity changed during canonical selection.');
	}
	return { canonicalPath, identity: sourcePathIdentity(canonicalPathStatus) };
}

function sourcePathIsWithinRoot(sourceRoot: string, candidatePath: string): boolean {
	const relativePath = path.relative(sourceRoot, candidatePath);
	return (
		relativePath === '' ||
		(!path.isAbsolute(relativePath) &&
			relativePath !== '..' &&
			!relativePath.startsWith(`..${path.sep}`))
	);
}

async function assertSourceGitRootAuthority(
	sourceRootAuthority: SourceGitRootAuthority,
): Promise<void> {
	const [handleStatus, currentPathStatus] = await Promise.all([
		sourceRootAuthority.directoryHandle.stat(),
		lstat(sourceRootAuthority.canonicalPath),
	]);
	if (
		!handleStatus.isDirectory() ||
		currentPathStatus.isSymbolicLink() ||
		!currentPathStatus.isDirectory() ||
		!sourcePathIdentitiesEqual(sourceRootAuthority.identity, sourcePathIdentity(handleStatus)) ||
		!sourcePathIdentitiesEqual(sourceRootAuthority.identity, sourcePathIdentity(currentPathStatus))
	) {
		throw new Error('Source Git directory authority changed while constructing its private view.');
	}
}

async function assertOpenedSourcePathAuthority(options: {
	readonly expectedKind: 'directory' | 'regular-file';
	readonly openedHandle: FileHandle;
	readonly sourcePath: string;
	readonly sourceRootAuthority: SourceGitRootAuthority;
}): Promise<Stats> {
	await assertSourceGitRootAuthority(options.sourceRootAuthority);
	const [canonicalOpenedPath, handleStatus, currentPathStatus] = await Promise.all([
		realpath(options.sourcePath),
		options.openedHandle.stat(),
		lstat(options.sourcePath),
	]);
	if (!sourcePathIsWithinRoot(options.sourceRootAuthority.canonicalPath, canonicalOpenedPath)) {
		throw new Error(
			`Opened source path '${options.sourcePath}' escaped the canonical source Git directory.`,
		);
	}
	if (currentPathStatus.isSymbolicLink()) {
		throw new Error(`Selected Git data '${options.sourcePath}' must not be a symbolic link.`);
	}
	const handleIdentity = sourcePathIdentity(handleStatus);
	if (!sourcePathIdentitiesEqual(handleIdentity, sourcePathIdentity(currentPathStatus))) {
		throw new Error(
			`Opened source path '${options.sourcePath}' no longer matches its handle identity.`,
		);
	}
	if (
		(options.expectedKind === 'directory' && !handleStatus.isDirectory()) ||
		(options.expectedKind === 'regular-file' && !handleStatus.isFile())
	) {
		throw new Error(
			`Opened source path '${options.sourcePath}' is not the required ${options.expectedKind}.`,
		);
	}
	await assertSourceGitRootAuthority(options.sourceRootAuthority);
	return handleStatus;
}

async function openSourceGitRootAuthority(
	selection: SourceGitRootSelection,
): Promise<SourceGitRootAuthority> {
	const directoryHandle = await open(
		selection.canonicalPath,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
	);
	const authority = { ...selection, directoryHandle } satisfies SourceGitRootAuthority;
	try {
		await assertSourceGitRootAuthority(authority);
		return authority;
	} catch (error) {
		await directoryHandle.close();
		throw error;
	}
}

function assertValidSelectedBranch(selectedReference: SanitizedGitSelectedBranch): void {
	if (!gitObjectIdPattern.test(selectedReference.objectId)) {
		throw new Error(
			`Invalid selected object id '${selectedReference.objectId}': expected a lowercase SHA-1 or SHA-256 object id.`,
		);
	}
	if (!selectedReference.name.startsWith('refs/heads/')) {
		throw new Error(
			`Invalid selected branch reference '${selectedReference.name}': expected refs/heads/<branch>.`,
		);
	}
	const branchName = selectedReference.name.slice('refs/heads/'.length);
	const referenceSegments = branchName.split('/');
	let hasForbiddenReferenceCharacter = false;
	for (const character of branchName) {
		const characterCode = character.codePointAt(0);
		if (
			characterCode === undefined ||
			characterCode <= 0x20 ||
			characterCode === 0x7f ||
			'~^:?*\\['.includes(character)
		) {
			hasForbiddenReferenceCharacter = true;
			break;
		}
	}
	if (
		branchName.length === 0 ||
		branchName.endsWith('.') ||
		branchName.includes('..') ||
		branchName.includes('@{') ||
		hasForbiddenReferenceCharacter ||
		referenceSegments.some(
			(referenceSegment) =>
				referenceSegment.length === 0 ||
				referenceSegment.startsWith('.') ||
				referenceSegment.endsWith('.lock'),
		)
	) {
		throw new Error(`Invalid selected branch reference '${selectedReference.name}'.`);
	}
}

async function assertLinkedWorktreeMetadataAbsent(
	sourceRootAuthority: SourceGitRootAuthority,
): Promise<void> {
	await assertSourceGitRootAuthority(sourceRootAuthority);
	const metadataStatuses = await Promise.all(
		linkedWorktreeMetadataNames.map(async (metadataName) => ({
			metadataName,
			status: await readOptionalPathStatus(
				path.join(sourceRootAuthority.canonicalPath, metadataName),
			),
		})),
	);
	for (const { metadataName, status } of metadataStatuses) {
		if (status !== undefined) {
			throw new Error(
				`Source Git directory contains unsupported linked-worktree metadata '${metadataName}'.`,
			);
		}
	}
	await assertSourceGitRootAuthority(sourceRootAuthority);
}

async function assertObjectAlternatesAbsent(
	sourceObjectsDirectory: string,
	sourceRootAuthority: SourceGitRootAuthority,
): Promise<void> {
	await assertSourceGitRootAuthority(sourceRootAuthority);
	const alternateStatuses = await Promise.all(
		objectAlternateNames.map(async (alternateName) => ({
			alternateName,
			status: await readOptionalPathStatus(
				path.join(sourceObjectsDirectory, 'info', alternateName),
			),
		})),
	);
	for (const { alternateName, status } of alternateStatuses) {
		if (status !== undefined) {
			throw new Error(
				`Source Git directory contains forbidden object alternate '${alternateName}'.`,
			);
		}
	}
	await assertSourceGitRootAuthority(sourceRootAuthority);
}

function assertStableRegularFileStatus(filePath: string, status: Stats): void {
	if (status.isSymbolicLink()) {
		throw new Error(`Selected Git data '${filePath}' must not be a symbolic link.`);
	}
	if (!status.isFile()) {
		throw new Error(`Selected Git data '${filePath}' must be a regular file.`);
	}
	if (status.nlink !== 1) {
		throw new Error(`Selected Git data '${filePath}' must not be hard-linked.`);
	}
}

function stableFileStatusesEqual(beforeStatus: Stats, afterStatus: Stats): boolean {
	return (
		beforeStatus.dev === afterStatus.dev &&
		beforeStatus.ino === afterStatus.ino &&
		beforeStatus.size === afterStatus.size &&
		beforeStatus.mtimeMs === afterStatus.mtimeMs &&
		beforeStatus.ctimeMs === afterStatus.ctimeMs &&
		afterStatus.nlink === 1
	);
}

async function copyFileHandleBytes(
	sourceFile: FileHandle,
	destinationFile: FileHandle,
): Promise<void> {
	const copyBuffer = Buffer.allocUnsafe(1024 * 1024);
	let readOffset = 0;
	while (true) {
		// oxlint-disable-next-line no-await-in-loop -- bounded sequential reads avoid buffering repository packs in memory.
		const { bytesRead } = await sourceFile.read(copyBuffer, 0, copyBuffer.length, readOffset);
		if (bytesRead === 0) return;
		let writtenBytes = 0;
		while (writtenBytes < bytesRead) {
			// oxlint-disable-next-line no-await-in-loop -- partial writes must complete before this destination offset advances.
			const { bytesWritten } = await destinationFile.write(
				copyBuffer,
				writtenBytes,
				bytesRead - writtenBytes,
				readOffset + writtenBytes,
			);
			if (bytesWritten <= 0) {
				throw new Error('Sanitized Git repository snapshot made no progress writing a file.');
			}
			writtenBytes += bytesWritten;
		}
		readOffset += bytesRead;
	}
}

async function copyStableRegularFile(options: {
	readonly destinationPath: string;
	readonly sourcePath: string;
	readonly sourceRootAuthority: SourceGitRootAuthority;
}): Promise<void> {
	const { destinationPath, sourcePath, sourceRootAuthority } = options;
	const initialPathStatus = await lstat(sourcePath);
	assertStableRegularFileStatus(sourcePath, initialPathStatus);
	let sourceFile;
	try {
		sourceFile = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if (errorCode(error) === 'ELOOP') {
			throw new Error(`Selected Git data '${sourcePath}' must not be a symbolic link.`, {
				cause: error,
			});
		}
		throw error;
	}
	let destinationFile;
	try {
		destinationFile = await open(
			destinationPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
	} catch (error) {
		await sourceFile.close();
		throw error;
	}
	try {
		const beforeReadStatus = await assertOpenedSourcePathAuthority({
			expectedKind: 'regular-file',
			openedHandle: sourceFile,
			sourcePath,
			sourceRootAuthority,
		});
		assertStableRegularFileStatus(sourcePath, beforeReadStatus);
		await copyFileHandleBytes(sourceFile, destinationFile);
		const afterReadStatus = await assertOpenedSourcePathAuthority({
			expectedKind: 'regular-file',
			openedHandle: sourceFile,
			sourcePath,
			sourceRootAuthority,
		});
		if (!stableFileStatusesEqual(beforeReadStatus, afterReadStatus)) {
			throw new Error(`Selected Git data '${sourcePath}' changed while being snapshotted.`);
		}
	} finally {
		await Promise.all([sourceFile.close(), destinationFile.close()]);
	}
}

async function readRealDirectoryEntries(options: {
	readonly dependencies: SanitizedGitRepositoryViewDependencies;
	readonly directoryPath: string;
	readonly label: string;
	readonly sourceRootAuthority: SourceGitRootAuthority;
}): Promise<Dirent[]> {
	const { dependencies, directoryPath, label, sourceRootAuthority } = options;
	const status = await lstat(directoryPath);
	if (status.isSymbolicLink()) {
		throw new Error(`${label} '${directoryPath}' must not be a symbolic link.`);
	}
	if (!status.isDirectory()) {
		throw new Error(`${label} '${directoryPath}' must be a real directory.`);
	}
	const directoryHandle = await open(
		directoryPath,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
	);
	try {
		await assertOpenedSourcePathAuthority({
			expectedKind: 'directory',
			openedHandle: directoryHandle,
			sourcePath: directoryPath,
			sourceRootAuthority,
		});
		const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
		await dependencies.afterSourceDirectoryRead?.(directoryPath);
		await assertOpenedSourcePathAuthority({
			expectedKind: 'directory',
			openedHandle: directoryHandle,
			sourcePath: directoryPath,
			sourceRootAuthority,
		});
		return directoryEntries;
	} finally {
		await directoryHandle.close();
	}
}

async function copyLooseObjectDirectory(options: {
	readonly dependencies: SanitizedGitRepositoryViewDependencies;
	readonly destinationDirectory: string;
	readonly sourceDirectory: string;
	readonly sourceRootAuthority: SourceGitRootAuthority;
}): Promise<void> {
	const objectEntries = await readRealDirectoryEntries({
		dependencies: options.dependencies,
		directoryPath: options.sourceDirectory,
		label: 'Loose Git object directory',
		sourceRootAuthority: options.sourceRootAuthority,
	});
	for (const objectEntry of objectEntries) {
		const sourceObjectPath = path.join(options.sourceDirectory, objectEntry.name);
		if (objectEntry.isSymbolicLink()) {
			throw new Error(`Selected Git data '${sourceObjectPath}' must not be a symbolic link.`);
		}
		if (!objectEntry.isFile()) {
			throw new Error(`Selected Git data '${sourceObjectPath}' must be a regular file.`);
		}
		if (!looseObjectFilePattern.test(objectEntry.name)) {
			throw new Error(`Unsupported loose Git object entry '${sourceObjectPath}'.`);
		}
	}
	await mkdir(options.destinationDirectory, { mode: 0o700 });
	await Promise.all(
		objectEntries.map(
			async (objectEntry) =>
				await copyStableRegularFile({
					destinationPath: path.join(options.destinationDirectory, objectEntry.name),
					sourcePath: path.join(options.sourceDirectory, objectEntry.name),
					sourceRootAuthority: options.sourceRootAuthority,
				}),
		),
	);
}

async function copyPackDirectory(options: {
	readonly dependencies: SanitizedGitRepositoryViewDependencies;
	readonly destinationDirectory: string;
	readonly sourceDirectory: string;
	readonly sourceRootAuthority: SourceGitRootAuthority;
}): Promise<void> {
	const packEntries = await readRealDirectoryEntries({
		dependencies: options.dependencies,
		directoryPath: options.sourceDirectory,
		label: 'Git pack directory',
		sourceRootAuthority: options.sourceRootAuthority,
	});
	const packPartsByObjectId = new Map<string, Set<'idx' | 'pack'>>();
	for (const packEntry of packEntries) {
		const sourcePackPath = path.join(options.sourceDirectory, packEntry.name);
		if (packEntry.isSymbolicLink()) {
			throw new Error(`Selected Git data '${sourcePackPath}' must not be a symbolic link.`);
		}
		if (!packEntry.isFile()) {
			throw new Error(`Unsupported Git pack entry '${sourcePackPath}'.`);
		}
		const match = packFilePattern.exec(packEntry.name);
		if (match === null) continue;
		const [, objectId, extension] = match;
		if (objectId === undefined || (extension !== 'idx' && extension !== 'pack')) {
			throw new Error(`Invalid Git pack entry '${sourcePackPath}'.`);
		}
		const packParts = packPartsByObjectId.get(objectId) ?? new Set<'idx' | 'pack'>();
		packParts.add(extension);
		packPartsByObjectId.set(objectId, packParts);
	}
	for (const [objectId, packParts] of packPartsByObjectId) {
		if (!packParts.has('idx') || !packParts.has('pack')) {
			throw new Error(`Git pack '${objectId}' must provide both regular .pack and .idx files.`);
		}
	}
	await mkdir(options.destinationDirectory, { mode: 0o700 });
	await Promise.all(
		[...packPartsByObjectId.keys()].flatMap((objectId) =>
			(['pack', 'idx'] as const).map(async (extension) => {
				const fileName = `pack-${objectId}.${extension}`;
				await copyStableRegularFile({
					destinationPath: path.join(options.destinationDirectory, fileName),
					sourcePath: path.join(options.sourceDirectory, fileName),
					sourceRootAuthority: options.sourceRootAuthority,
				});
			}),
		),
	);
}

async function copySelectedObjectStorage(options: {
	readonly dependencies: SanitizedGitRepositoryViewDependencies;
	readonly destinationGitDirectory: string;
	readonly sourceRootAuthority: SourceGitRootAuthority;
}): Promise<void> {
	const sourceObjectsDirectory = path.join(options.sourceRootAuthority.canonicalPath, 'objects');
	const destinationObjectsDirectory = path.join(options.destinationGitDirectory, 'objects');
	const objectEntries = await readRealDirectoryEntries({
		dependencies: options.dependencies,
		directoryPath: sourceObjectsDirectory,
		label: 'Source Git objects directory',
		sourceRootAuthority: options.sourceRootAuthority,
	});
	await assertObjectAlternatesAbsent(sourceObjectsDirectory, options.sourceRootAuthority);
	await mkdir(destinationObjectsDirectory, { mode: 0o700 });
	const copyOperations: (() => Promise<void>)[] = [];
	for (const objectEntry of objectEntries) {
		const sourceObjectPath = path.join(sourceObjectsDirectory, objectEntry.name);
		if (objectEntry.isSymbolicLink()) {
			throw new Error(`Selected Git data '${sourceObjectPath}' must not be a symbolic link.`);
		}
		if (objectEntry.name === 'info' && objectEntry.isDirectory()) continue;
		if (objectEntry.name === 'pack' && objectEntry.isDirectory()) {
			copyOperations.push(
				async () =>
					await copyPackDirectory({
						dependencies: options.dependencies,
						destinationDirectory: path.join(destinationObjectsDirectory, 'pack'),
						sourceDirectory: sourceObjectPath,
						sourceRootAuthority: options.sourceRootAuthority,
					}),
			);
			continue;
		}
		if (objectEntry.isDirectory() && looseObjectDirectoryPattern.test(objectEntry.name)) {
			copyOperations.push(
				async () =>
					await copyLooseObjectDirectory({
						dependencies: options.dependencies,
						destinationDirectory: path.join(destinationObjectsDirectory, objectEntry.name),
						sourceDirectory: sourceObjectPath,
						sourceRootAuthority: options.sourceRootAuthority,
					}),
			);
			continue;
		}
		throw new Error(`Unsupported Git object storage entry '${sourceObjectPath}'.`);
	}
	await Promise.all(copyOperations.map(async (copyOperation) => await copyOperation()));
}

async function copyOptionalIndex(options: {
	readonly destinationGitDirectory: string;
	readonly indexPolicy: SanitizedGitIndexPolicy;
	readonly sourceRootAuthority: SourceGitRootAuthority;
}): Promise<void> {
	if (options.indexPolicy.kind === 'omit') return;
	const sourceIndexPath = path.join(options.sourceRootAuthority.canonicalPath, 'index');
	const sourceIndexStatus = await readOptionalPathStatus(sourceIndexPath);
	if (sourceIndexStatus === undefined) return;
	assertStableRegularFileStatus(sourceIndexPath, sourceIndexStatus);
	await copyStableRegularFile({
		destinationPath: path.join(options.destinationGitDirectory, 'index'),
		sourcePath: sourceIndexPath,
		sourceRootAuthority: options.sourceRootAuthority,
	});
}

function buildSanitizedGitProcessContract(options: {
	readonly gitDirectory: string;
	readonly rootDirectory: string;
	readonly workTreeDirectory: string;
}): SanitizedGitProcessContract {
	return {
		argumentsPrefix: [
			`--git-dir=${options.gitDirectory}`,
			`--work-tree=${options.workTreeDirectory}`,
		],
		environment: {
			kind: 'replace',
			variables: {
				GIT_ASKPASS: disabledExecutable,
				GIT_CONFIG_GLOBAL: '/dev/null',
				GIT_CONFIG_NOSYSTEM: '1',
				GIT_CONFIG_SYSTEM: '/dev/null',
				GIT_EDITOR: disabledExecutable,
				GIT_PAGER: 'cat',
				GIT_SEQUENCE_EDITOR: disabledExecutable,
				GIT_SSH: disabledExecutable,
				GIT_SSH_COMMAND: disabledExecutable,
				GIT_TERMINAL_PROMPT: '0',
				HOME: path.join(options.rootDirectory, 'home'),
				LANG: 'C',
				LC_ALL: 'C',
				PAGER: 'cat',
				PATH: '/usr/bin:/bin',
				SSH_ASKPASS: disabledExecutable,
				XDG_CONFIG_HOME: path.join(options.rootDirectory, 'xdg-config'),
			},
		},
		executable: trustedGitExecutable,
	};
}

async function buildSanitizedGitRepositoryView(options: {
	readonly canonicalWorkTreeDirectory: string;
	readonly dependencies: SanitizedGitRepositoryViewDependencies;
	readonly indexPolicy: SanitizedGitIndexPolicy;
	readonly rootDirectory: string;
	readonly selectedReference: SanitizedGitSelectedBranch;
	readonly sourceRootAuthority: SourceGitRootAuthority;
}): Promise<SanitizedGitRepositoryView> {
	const gitDirectory = path.join(options.rootDirectory, 'repository.git');
	await Promise.all([
		mkdir(gitDirectory, { mode: 0o700 }),
		mkdir(path.join(options.rootDirectory, 'home'), { mode: 0o700 }),
		mkdir(path.join(options.rootDirectory, 'xdg-config'), { mode: 0o700 }),
	]);
	await copySelectedObjectStorage({
		dependencies: options.dependencies,
		destinationGitDirectory: gitDirectory,
		sourceRootAuthority: options.sourceRootAuthority,
	});
	await copyOptionalIndex({
		destinationGitDirectory: gitDirectory,
		indexPolicy: options.indexPolicy,
		sourceRootAuthority: options.sourceRootAuthority,
	});
	const referencePath = path.join(gitDirectory, ...options.selectedReference.name.split('/'));
	await mkdir(path.dirname(referencePath), { mode: 0o700, recursive: true });
	await Promise.all([
		writeFile(path.join(gitDirectory, 'config'), trustedRepositoryConfig, {
			flag: 'wx',
			mode: 0o600,
		}),
		writeFile(path.join(gitDirectory, 'HEAD'), `ref: ${options.selectedReference.name}\n`, {
			flag: 'wx',
			mode: 0o600,
		}),
		writeFile(referencePath, `${options.selectedReference.objectId}\n`, {
			flag: 'wx',
			mode: 0o600,
		}),
	]);
	return {
		gitDirectory,
		gitProcess: buildSanitizedGitProcessContract({
			gitDirectory,
			rootDirectory: options.rootDirectory,
			workTreeDirectory: options.canonicalWorkTreeDirectory,
		}),
		kind: 'sanitized-git-repository-view',
		rootDirectory: options.rootDirectory,
		selectedReference: options.selectedReference,
		workTreeDirectory: options.canonicalWorkTreeDirectory,
	};
}

export async function withSanitizedGitRepositoryView<TResult>(
	options: SanitizedGitRepositoryViewOptions,
	operation: (view: SanitizedGitRepositoryView) => Promise<TResult>,
	dependencies: SanitizedGitRepositoryViewDependencies = {},
): Promise<TResult> {
	assertValidSelectedBranch(options.selectedReference);
	const [sourceRootSelection, canonicalWorkTreeDirectory] = await Promise.all([
		resolveSourceGitRootSelection(options.sourceGitDirectory),
		resolveRealDirectory(options.workTreeDirectory, 'Git worktree directory'),
	]);
	const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-sanitized-git-view-'));
	let operationOutcome:
		| { readonly kind: 'failed'; readonly error: unknown }
		| { readonly kind: 'succeeded'; readonly result: TResult };
	try {
		await chmod(rootDirectory, 0o700);
		const sourceRootAuthority = await openSourceGitRootAuthority(sourceRootSelection);
		let view: SanitizedGitRepositoryView;
		try {
			await assertLinkedWorktreeMetadataAbsent(sourceRootAuthority);
			view = await buildSanitizedGitRepositoryView({
				canonicalWorkTreeDirectory,
				dependencies,
				indexPolicy: options.index,
				rootDirectory,
				selectedReference: options.selectedReference,
				sourceRootAuthority,
			});
			await assertSourceGitRootAuthority(sourceRootAuthority);
		} finally {
			await sourceRootAuthority.directoryHandle.close();
		}
		operationOutcome = { kind: 'succeeded', result: await operation(view) };
	} catch (error) {
		operationOutcome = { error, kind: 'failed' };
	}
	try {
		await rm(rootDirectory, { force: true, recursive: true });
	} catch (cleanupError) {
		if (operationOutcome.kind === 'failed') {
			// oxlint-disable-next-line preserve-caught-error -- AggregateError preserves operation and cleanup failures.
			throw new AggregateError(
				[operationOutcome.error, cleanupError],
				'Sanitized Git repository operation and view cleanup both failed.',
				{ cause: operationOutcome.error },
			);
		}
		throw cleanupError;
	}
	if (operationOutcome.kind === 'failed') throw operationOutcome.error;
	return operationOutcome.result;
}
