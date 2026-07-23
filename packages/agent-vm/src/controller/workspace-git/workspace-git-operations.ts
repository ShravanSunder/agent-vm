import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { execa } from 'execa';

import { gitBranchNameSchema } from '../../config/system-config.js';
import { materializeManagedAgentGitDirectoryRoot } from '../../gateway/managed-agent-root-storage.js';
import { parseGithubRepositoryFromUrl, scrubGithubTokenFromOutput } from '../git-auth-support.js';
import {
	type SanitizedGitRepositoryView,
	withSanitizedGitRepositoryView,
} from '../sanitized-git-repository-view.js';
import {
	TOOL_VM_WORKSPACE_GIT_DIRECTORY,
	resolveWorkspaceGitPaths,
} from './workspace-git-paths.js';

const GIT_EXECUTABLE_PATH = '/usr/bin/git';
const GIT_OPERATION_TIMEOUT_MS = 120_000;
const LOCAL_WORKSPACE_GIT_BRANCH = 'agent/workspace';
const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const PACKED_REFS_MAXIMUM_BYTES = 4 * 1024 * 1024;
const CLOSED_GIT_ENVIRONMENT = Object.freeze({
	GIT_ASKPASS: '/usr/bin/false',
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_SSH_COMMAND: '/usr/bin/false',
	GIT_TERMINAL_PROMPT: '0',
	HOME: '/nonexistent/agent-vm-git-home',
	LC_ALL: 'C',
	PATH: '/usr/bin:/bin',
	SSH_ASKPASS: '/usr/bin/false',
	XDG_CONFIG_HOME: '/nonexistent/agent-vm-git-xdg',
});

function parseWorkspaceGitObjectId(value: string, context: string): string {
	if (!GIT_OBJECT_ID_PATTERN.test(value)) {
		throw new Error(`${context} must be an exact lowercase SHA-1 or SHA-256 object id.`);
	}
	return value;
}

export type WorkspaceGitInitializationPolicy =
	| {
			readonly kind: 'local';
	  }
	| {
			readonly branch: string;
			readonly kind: 'remote';
			readonly remoteUrl: string;
	  };

export interface MaterializedWorkspaceGitRepository {
	readonly branch: string;
	readonly hostGitDirectory: string;
	readonly hostWorkspaceDirectory: string;
	readonly mode: WorkspaceGitInitializationPolicy['kind'];
}

export interface WorkspaceGitRemoteOperationConfig {
	readonly agentId: string;
	readonly branch: string;
	readonly defaultBranch?: string;
	readonly githubToken?: string;
	readonly hostWorkspaceDirectory: string;
	readonly remoteUrl: string;
	readonly zoneRuntimeDir: string;
	readonly zoneId: string;
}

export interface WorkspaceGitCommitSummary {
	readonly sha: string;
	readonly subject: string;
}

export interface WorkspaceGitPushResult {
	readonly branch: string;
	readonly localHead: string;
	readonly pushedCommits: readonly WorkspaceGitCommitSummary[];
	readonly remoteHead: string;
}

export interface WorkspaceGitPushOptions extends WorkspaceGitRemoteOperationConfig {
	readonly expectedHead: string;
}

interface WorkspaceGitPushDependencies {
	readonly beforePushCompareAndSwap?: (observation: {
		readonly branch: string;
		readonly localHead: string;
		readonly remoteHead: string | null;
	}) => Promise<void>;
}

interface WorkspaceGitPushNotDispatchedErrorOptions {
	readonly cause?: unknown;
	readonly errorClass: string;
	readonly message: string;
	readonly safeMessage: string;
}

export class WorkspaceGitPushNotDispatchedError extends Error {
	public readonly errorClass: string;
	public readonly safeMessage: string;

	public constructor(options: WorkspaceGitPushNotDispatchedErrorOptions) {
		super(options.message, { cause: options.cause });
		this.name = 'WorkspaceGitPushNotDispatchedError';
		this.errorClass = options.errorClass;
		this.safeMessage = options.safeMessage;
	}
}

export class WorkspaceGitConflictError extends WorkspaceGitPushNotDispatchedError {
	public constructor(message: string) {
		super({
			errorClass: 'workspace_git_conflict',
			message,
			safeMessage:
				'Workspace Git push was rejected before dispatch because repository state changed.',
		});
		this.name = 'WorkspaceGitConflictError';
	}
}

export class WorkspaceGitDefaultBranchError extends WorkspaceGitPushNotDispatchedError {
	public constructor(message: string) {
		super({
			errorClass: 'workspace_git_default_branch',
			message,
			safeMessage: 'Workspace Git push to the configured default branch is not allowed.',
		});
		this.name = 'WorkspaceGitDefaultBranchError';
	}
}

type WorkspaceGitAuthentication =
	| { readonly kind: 'none' }
	| { readonly githubToken: string; readonly kind: 'github-token' };

type WorkspaceGitRemote =
	| {
			readonly authentication: { readonly kind: 'none' };
			readonly protocol: 'file';
			readonly url: string;
	  }
	| {
			readonly authentication: { readonly githubToken: string; readonly kind: 'github-token' };
			readonly protocol: 'https';
			readonly url: string;
	  };

interface WorkspaceGitCommandResult {
	readonly exitCode: number;
	readonly stderr: string;
	readonly stdout: string;
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await lstat(filePath);
		return true;
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
			return false;
		}
		throw error;
	}
}

async function assertRealDirectory(directoryPath: string): Promise<void> {
	const status = await lstat(directoryPath);
	if (!status.isDirectory() || status.isSymbolicLink()) {
		throw new Error(`Workspace Git path '${directoryPath}' must be a real directory.`);
	}
}

async function writeWorkspaceGitPointer(hostWorkspaceDirectory: string): Promise<void> {
	const pointerPath = path.join(hostWorkspaceDirectory, '.git');
	const temporaryPointerPath = path.join(
		hostWorkspaceDirectory,
		`.agent-vm-workspace-git-pointer-${randomUUID()}.tmp`,
	);
	const pointerHandle = await open(temporaryPointerPath, 'wx', 0o644);
	try {
		await pointerHandle.writeFile(`gitdir: ${TOOL_VM_WORKSPACE_GIT_DIRECTORY}\n`, 'utf8');
		await pointerHandle.sync();
		await pointerHandle.close();
		await rename(temporaryPointerPath, pointerPath);
	} catch (error) {
		await pointerHandle.close().catch(() => undefined);
		await rm(temporaryPointerPath, { force: true });
		throw error;
	}
}

async function initializeWorkspaceGitDirectory(options: {
	readonly branch: string;
	readonly hostGitDirectory: string;
	readonly hostWorkspaceDirectory: string;
	readonly policy: WorkspaceGitInitializationPolicy;
}): Promise<void> {
	await execa(
		GIT_EXECUTABLE_PATH,
		[
			'init',
			`--separate-git-dir=${options.hostGitDirectory}`,
			`--initial-branch=${options.branch}`,
			options.hostWorkspaceDirectory,
		],
		{
			env: CLOSED_GIT_ENVIRONMENT,
			extendEnv: false,
			reject: true,
			timeout: GIT_OPERATION_TIMEOUT_MS,
		},
	);
	const workspaceGitArguments = [
		`--git-dir=${options.hostGitDirectory}`,
		`--work-tree=${options.hostWorkspaceDirectory}`,
	];
	const workspaceGitCommandOptions = {
		env: CLOSED_GIT_ENVIRONMENT,
		extendEnv: false,
		reject: false,
		timeout: GIT_OPERATION_TIMEOUT_MS,
	};
	const currentHeadReference = await execa(
		GIT_EXECUTABLE_PATH,
		[...workspaceGitArguments, 'symbolic-ref', '--quiet', 'HEAD'],
		workspaceGitCommandOptions,
	);
	if (currentHeadReference.exitCode === 0) {
		const repositoryHasRefs = await execa(
			GIT_EXECUTABLE_PATH,
			[...workspaceGitArguments, 'show-ref', '--quiet'],
			workspaceGitCommandOptions,
		);
		if (repositoryHasRefs.exitCode !== 0 && repositoryHasRefs.exitCode !== 1) {
			throw new Error('Workspace Git failed to inspect existing references.');
		}
		if (repositoryHasRefs.exitCode === 1) {
			await execa(
				GIT_EXECUTABLE_PATH,
				[...workspaceGitArguments, 'symbolic-ref', 'HEAD', `refs/heads/${options.branch}`],
				{ ...workspaceGitCommandOptions, reject: true },
			);
		}
	} else if (currentHeadReference.exitCode !== 1) {
		throw new Error('Workspace Git failed to inspect its current HEAD reference.');
	}
	const gitConfigLines = [
		'[core]',
		'\trepositoryformatversion = 0',
		'\tfilemode = true',
		'\tbare = false',
		'\tworktree = /workspace',
		'\thooksPath = /dev/null',
		'[commit]',
		'\tgpgsign = false',
	];
	if (options.policy.kind === 'remote') {
		gitConfigLines.push(
			'[remote "origin"]',
			`\turl = ${options.policy.remoteUrl}`,
			`\tfetch = +refs/heads/${options.branch}:refs/remotes/origin/${options.branch}`,
			`[branch "${options.branch}"]`,
			'\tremote = origin',
			`\tmerge = refs/heads/${options.branch}`,
		);
	}
	await writeFile(path.join(options.hostGitDirectory, 'config'), `${gitConfigLines.join('\n')}\n`, {
		encoding: 'utf8',
		mode: 0o600,
	});
}

export async function materializeWorkspaceGitRepository(options: {
	readonly agentId: string;
	readonly hostWorkspaceDirectory: string;
	readonly policy: WorkspaceGitInitializationPolicy;
	readonly zoneRuntimeDir: string;
	readonly zoneId: string;
}): Promise<MaterializedWorkspaceGitRepository> {
	await assertRealDirectory(options.hostWorkspaceDirectory);
	await materializeManagedAgentGitDirectoryRoot({
		agentId: options.agentId,
		zoneRuntimeDir: options.zoneRuntimeDir,
	});
	const workspaceGitPaths = resolveWorkspaceGitPaths({
		agentId: options.agentId,
		zoneRuntimeDir: options.zoneRuntimeDir,
		zoneId: options.zoneId,
	});
	await mkdir(workspaceGitPaths.hostGitDirectoryRoot, { mode: 0o700, recursive: true });
	const branch =
		options.policy.kind === 'local' ? LOCAL_WORKSPACE_GIT_BRANCH : options.policy.branch;
	if (!(await pathExists(workspaceGitPaths.hostGitDirectory))) {
		await initializeWorkspaceGitDirectory({
			branch,
			hostGitDirectory: workspaceGitPaths.hostGitDirectory,
			hostWorkspaceDirectory: options.hostWorkspaceDirectory,
			policy: options.policy,
		});
	}
	await assertRealDirectory(workspaceGitPaths.hostGitDirectory);
	await writeWorkspaceGitPointer(options.hostWorkspaceDirectory);
	return {
		branch,
		hostGitDirectory: workspaceGitPaths.hostGitDirectory,
		hostWorkspaceDirectory: options.hostWorkspaceDirectory,
		mode: options.policy.kind,
	};
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

async function readOptionalStableGitTextFile(
	filePath: string,
	maximumBytes: number,
): Promise<string | undefined> {
	let fileHandle: Awaited<ReturnType<typeof open>>;
	try {
		fileHandle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
			return undefined;
		}
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ELOOP') {
			throw new Error(`Workspace Git authority file '${filePath}' must not be a symbolic link.`, {
				cause: error,
			});
		}
		throw error;
	}
	try {
		const beforeReadStatus = await fileHandle.stat();
		if (!beforeReadStatus.isFile() || beforeReadStatus.nlink !== 1) {
			throw new Error(
				`Workspace Git authority file '${filePath}' must be one non-linked regular file.`,
			);
		}
		if (beforeReadStatus.size > maximumBytes) {
			throw new Error(`Workspace Git authority file '${filePath}' exceeds ${maximumBytes} bytes.`);
		}
		const fileBytes = await fileHandle.readFile();
		const afterReadStatus = await fileHandle.stat();
		if (!stableFileStatusesEqual(beforeReadStatus, afterReadStatus)) {
			throw new Error(`Workspace Git authority file '${filePath}' changed while being read.`);
		}
		return fileBytes.toString('utf8');
	} finally {
		await fileHandle.close();
	}
}

async function readWorkspaceGitBranchObjectIdFromDirectory(options: {
	readonly branch: string;
	readonly gitDirectory: string;
}): Promise<string | null> {
	const branch = gitBranchNameSchema.parse(options.branch);
	const referenceName = `refs/heads/${branch}`;
	const looseReference = await readOptionalStableGitTextFile(
		path.join(options.gitDirectory, ...referenceName.split('/')),
		256,
	);
	if (looseReference !== undefined) {
		return parseWorkspaceGitObjectId(
			looseReference.trim(),
			`Workspace Git branch '${branch}' loose object id`,
		);
	}
	const packedReferences = await readOptionalStableGitTextFile(
		path.join(options.gitDirectory, 'packed-refs'),
		PACKED_REFS_MAXIMUM_BYTES,
	);
	if (packedReferences === undefined) {
		return null;
	}
	let selectedObjectId: string | null = null;
	for (const packedReferenceLine of packedReferences.split('\n')) {
		if (
			packedReferenceLine.length === 0 ||
			packedReferenceLine.startsWith('#') ||
			packedReferenceLine.startsWith('^')
		) {
			continue;
		}
		const separatorIndex = packedReferenceLine.indexOf(' ');
		if (separatorIndex === -1) {
			throw new Error('Workspace Git packed-refs contains an invalid record.');
		}
		const objectId = packedReferenceLine.slice(0, separatorIndex);
		const packedReferenceName = packedReferenceLine.slice(separatorIndex + 1);
		parseWorkspaceGitObjectId(objectId, 'Workspace Git packed-refs object id');
		if (packedReferenceName === referenceName) {
			if (selectedObjectId !== null) {
				throw new Error(`Workspace Git packed-refs repeats branch '${branch}'.`);
			}
			selectedObjectId = objectId;
		}
	}
	return selectedObjectId;
}

export async function resolveWorkspaceGitBranchObjectId(options: {
	readonly agentId: string;
	readonly branch: string;
	readonly zoneRuntimeDir: string;
	readonly zoneId: string;
}): Promise<string | null> {
	const workspaceGitPaths = resolveWorkspaceGitPaths({
		agentId: options.agentId,
		zoneRuntimeDir: options.zoneRuntimeDir,
		zoneId: options.zoneId,
	});
	return await readWorkspaceGitBranchObjectIdFromDirectory({
		branch: options.branch,
		gitDirectory: workspaceGitPaths.hostGitDirectory,
	});
}

function resolveWorkspaceGitRemote(
	options: Pick<WorkspaceGitRemoteOperationConfig, 'githubToken' | 'remoteUrl'>,
): WorkspaceGitRemote {
	if (path.isAbsolute(options.remoteUrl) || options.remoteUrl.startsWith('file://')) {
		return {
			authentication: { kind: 'none' },
			protocol: 'file',
			url: options.remoteUrl,
		};
	}
	if (options.githubToken === undefined || options.githubToken.length === 0) {
		throw new Error('Remote workspace Git requires the controller GitHub token.');
	}
	return {
		authentication: { githubToken: options.githubToken, kind: 'github-token' },
		protocol: 'https',
		url: `https://github.com/${parseGithubRepositoryFromUrl(options.remoteUrl)}.git`,
	};
}

function buildWorkspaceGitCommandEnvironment(options: {
	readonly authentication: WorkspaceGitAuthentication;
	readonly view: SanitizedGitRepositoryView;
}): Readonly<Record<string, string>> {
	const baseEnvironment = options.view.gitProcess.environment.variables;
	if (options.authentication.kind === 'none') {
		return { ...baseEnvironment };
	}
	const authorizationHeader = `Authorization: Basic ${Buffer.from(
		`x-access-token:${options.authentication.githubToken}`,
	).toString('base64')}`;
	return {
		...baseEnvironment,
		GIT_CONFIG_COUNT: '1',
		GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
		GIT_CONFIG_VALUE_0: authorizationHeader,
	};
}

async function runSanitizedWorkspaceGitCommand(options: {
	readonly argumentsList: readonly string[];
	readonly authentication: WorkspaceGitAuthentication;
	readonly protocol: WorkspaceGitRemote['protocol'] | 'none';
	readonly reject?: boolean;
	readonly view: SanitizedGitRepositoryView;
}): Promise<WorkspaceGitCommandResult> {
	const protocolArguments =
		options.protocol === 'none' ? [] : ['-c', `protocol.${options.protocol}.allow=always`];
	const result = await execa(
		options.view.gitProcess.executable,
		[...options.view.gitProcess.argumentsPrefix, ...protocolArguments, ...options.argumentsList],
		{
			cwd: options.view.workTreeDirectory,
			env: buildWorkspaceGitCommandEnvironment({
				authentication: options.authentication,
				view: options.view,
			}),
			extendEnv: false,
			reject: false,
			timeout: GIT_OPERATION_TIMEOUT_MS,
		},
	);
	const commandResult = {
		exitCode: typeof result.exitCode === 'number' ? result.exitCode : 128,
		stderr: scrubGithubTokenFromOutput(result.stderr),
		stdout: scrubGithubTokenFromOutput(result.stdout),
	} satisfies WorkspaceGitCommandResult;
	if (options.reject === true && commandResult.exitCode !== 0) {
		throw new Error(
			`Workspace Git command failed: ${commandResult.stdout}\n${commandResult.stderr}`.trim(),
		);
	}
	return commandResult;
}

async function runSanitizedWorkspaceGitStdout(options: {
	readonly argumentsList: readonly string[];
	readonly authentication: WorkspaceGitAuthentication;
	readonly protocol: WorkspaceGitRemote['protocol'] | 'none';
	readonly view: SanitizedGitRepositoryView;
}): Promise<string> {
	return (
		await runSanitizedWorkspaceGitCommand({
			...options,
			reject: true,
		})
	).stdout.trim();
}

function parseRemoteHead(output: string, referenceName: string): string | null {
	if (output.trim().length === 0) {
		return null;
	}
	const lines = output.trim().split('\n');
	if (lines.length !== 1) {
		throw new Error(`Workspace Git remote returned multiple records for '${referenceName}'.`);
	}
	const [objectId, observedReferenceName] = (lines[0] ?? '').split(/\s+/u);
	if (observedReferenceName !== referenceName) {
		throw new Error(`Workspace Git remote returned an invalid record for '${referenceName}'.`);
	}
	return parseWorkspaceGitObjectId(
		objectId ?? '',
		`Workspace Git remote record for '${referenceName}'`,
	);
}

function parseCommitSummaries(output: string): readonly WorkspaceGitCommitSummary[] {
	if (output.trim().length === 0) {
		return [];
	}
	return output
		.trim()
		.split('\n')
		.map((line): WorkspaceGitCommitSummary => {
			const separatorIndex = line.indexOf('\t');
			if (separatorIndex === -1) {
				throw new Error('Workspace Git commit summary contains an invalid record.');
			}
			const sha = line.slice(0, separatorIndex);
			return {
				sha: parseWorkspaceGitObjectId(sha, 'Workspace Git commit summary object id'),
				subject: line.slice(separatorIndex + 1),
			};
		});
}

function assertWorkspaceGitPushBranchAllowed(options: WorkspaceGitRemoteOperationConfig): void {
	if (options.defaultBranch === options.branch) {
		throw new WorkspaceGitDefaultBranchError(
			`Workspace Git push for agent '${options.agentId}' refuses configured default branch '${options.branch}'.`,
		);
	}
}

async function executeWorkspaceGitPush(
	options: WorkspaceGitPushOptions,
	dependencies: WorkspaceGitPushDependencies,
	markPushMayHaveStarted: () => void,
): Promise<WorkspaceGitPushResult> {
	const branch = gitBranchNameSchema.parse(options.branch);
	let expectedHead: string;
	try {
		expectedHead = parseWorkspaceGitObjectId(options.expectedHead, 'Workspace Git expectedHead');
	} catch {
		throw new WorkspaceGitConflictError(
			'Workspace Git expectedHead must be an exact lowercase SHA-1 or SHA-256 object id.',
		);
	}
	assertWorkspaceGitPushBranchAllowed(options);
	const localHead = await resolveWorkspaceGitBranchObjectId({
		agentId: options.agentId,
		branch,
		zoneRuntimeDir: options.zoneRuntimeDir,
		zoneId: options.zoneId,
	});
	if (localHead === null) {
		throw new Error(`Workspace Git repository for agent '${options.agentId}' has no local head.`);
	}
	if (localHead !== expectedHead) {
		throw new WorkspaceGitConflictError(
			`Workspace Git local head '${localHead}' does not match expectedHead '${expectedHead}'.`,
		);
	}
	const remote = resolveWorkspaceGitRemote(options);
	const referenceName = `refs/heads/${branch}`;
	const workspaceGitPaths = resolveWorkspaceGitPaths({
		agentId: options.agentId,
		zoneRuntimeDir: options.zoneRuntimeDir,
		zoneId: options.zoneId,
	});
	return await withSanitizedGitRepositoryView(
		{
			index: { kind: 'omit' },
			selectedReference: {
				kind: 'branch',
				name: referenceName,
				objectId: localHead,
			},
			sourceGitDirectory: workspaceGitPaths.hostGitDirectory,
			workTreeDirectory: options.hostWorkspaceDirectory,
		},
		async (view): Promise<WorkspaceGitPushResult> => {
			await runSanitizedWorkspaceGitStdout({
				argumentsList: ['cat-file', '-e', `${localHead}^{commit}`],
				authentication: { kind: 'none' },
				protocol: 'none',
				view,
			});
			const remoteHead = parseRemoteHead(
				await runSanitizedWorkspaceGitStdout({
					argumentsList: ['ls-remote', remote.url, referenceName],
					authentication: remote.authentication,
					protocol: remote.protocol,
					view,
				}),
				referenceName,
			);
			if (remoteHead !== null) {
				await runSanitizedWorkspaceGitStdout({
					argumentsList: [
						'fetch',
						'--no-tags',
						remote.url,
						`+${referenceName}:refs/remotes/origin/${branch}`,
					],
					authentication: remote.authentication,
					protocol: remote.protocol,
					view,
				});
				const fetchedRemoteHead = parseWorkspaceGitObjectId(
					await runSanitizedWorkspaceGitStdout({
						argumentsList: ['rev-parse', '--verify', `refs/remotes/origin/${branch}`],
						authentication: { kind: 'none' },
						protocol: 'none',
						view,
					}),
					`Workspace Git fetched remote branch '${branch}'`,
				);
				if (fetchedRemoteHead !== remoteHead) {
					throw new WorkspaceGitConflictError(
						`Workspace Git remote branch '${branch}' changed while its observed head was fetched.`,
					);
				}
				const ancestryResult = await runSanitizedWorkspaceGitCommand({
					argumentsList: ['merge-base', '--is-ancestor', remoteHead, localHead],
					authentication: { kind: 'none' },
					protocol: 'none',
					view,
				});
				if (ancestryResult.exitCode === 1) {
					throw new WorkspaceGitConflictError(
						`Workspace Git remote head '${remoteHead}' is not an ancestor of local head '${localHead}'.`,
					);
				}
				if (ancestryResult.exitCode !== 0) {
					throw new Error(
						`Workspace Git ancestry check failed: ${ancestryResult.stdout}\n${ancestryResult.stderr}`.trim(),
					);
				}
			}
			const commitRange =
				remoteHead === null ? localHead : `refs/remotes/origin/${branch}..${localHead}`;
			const pushedCommits = parseCommitSummaries(
				await runSanitizedWorkspaceGitStdout({
					argumentsList: ['log', '--reverse', '--format=%H%x09%s', commitRange],
					authentication: { kind: 'none' },
					protocol: 'none',
					view,
				}),
			);
			await dependencies.beforePushCompareAndSwap?.({ branch, localHead, remoteHead });
			markPushMayHaveStarted();
			await runSanitizedWorkspaceGitStdout({
				argumentsList: [
					'push',
					`--force-with-lease=${referenceName}:${remoteHead ?? ''}`,
					remote.url,
					`${localHead}:${referenceName}`,
				],
				authentication: remote.authentication,
				protocol: remote.protocol,
				view,
			});
			const verifiedRemoteHead = parseRemoteHead(
				await runSanitizedWorkspaceGitStdout({
					argumentsList: ['ls-remote', remote.url, referenceName],
					authentication: remote.authentication,
					protocol: remote.protocol,
					view,
				}),
				referenceName,
			);
			if (verifiedRemoteHead !== localHead) {
				throw new Error('Workspace Git push did not produce the expected remote head.');
			}
			return {
				branch,
				localHead,
				pushedCommits,
				remoteHead: verifiedRemoteHead,
			};
		},
	);
}

export async function pushWorkspaceGit(
	options: WorkspaceGitPushOptions,
	dependencies: WorkspaceGitPushDependencies = {},
): Promise<WorkspaceGitPushResult> {
	let pushMayHaveStarted = false;
	try {
		return await executeWorkspaceGitPush(options, dependencies, () => {
			pushMayHaveStarted = true;
		});
	} catch (error) {
		if (pushMayHaveStarted || error instanceof WorkspaceGitPushNotDispatchedError) {
			throw error;
		}
		throw new WorkspaceGitPushNotDispatchedError({
			cause: error,
			errorClass: 'workspace_git_push_not_dispatched',
			message: 'Workspace Git push failed before the push subprocess was dispatched.',
			safeMessage: 'Workspace Git push failed before remote mutation.',
		});
	}
}
