import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { execa } from 'execa';

import { buildGithubTokenUrl, scrubGithubTokenFromOutput } from '../git-auth-support.js';
import type { GitCommandResult } from '../git-retry-support.js';
import { OPENCLAW_ZONE_GIT_GUEST_DIR, resolveZoneGitPaths } from './zone-git-paths.js';

const GIT_OPERATION_TIMEOUT_MS = 120_000;
const defaultProtectedZoneGitPushBranchNames = ['main', 'master'] as const;

export interface ZoneGitReadConfig {
	readonly branch: string;
	readonly defaultBranch?: string;
	readonly githubToken?: string;
	readonly protectedBranches?: readonly string[];
	readonly protectedBranchPatterns?: readonly string[];
	readonly remoteUrl: string;
	readonly runtimeDir: string;
	readonly zoneFilesDir: string;
	readonly zoneId: string;
}

interface InitializedZoneGitStatus {
	readonly aheadOfRemote: number;
	readonly behindRemote: number;
	readonly branch: string;
	readonly dirty: boolean;
	readonly initialized: true;
	readonly kind: 'initialized';
	readonly localHead: string | null;
	readonly remoteHead: string | null;
}

interface UninitializedZoneGitStatus {
	readonly aheadOfRemote: 0;
	readonly behindRemote: 0;
	readonly branch: string;
	readonly dirty: false;
	readonly initialized: false;
	readonly kind: 'uninitialized';
	readonly localHead: null;
	readonly remoteHead: null;
}

export type ZoneGitStatus = InitializedZoneGitStatus | UninitializedZoneGitStatus;

export interface ZoneGitCommitSummary {
	readonly sha: string;
	readonly subject: string;
}

export interface ZoneGitPushResult {
	readonly branch: string;
	readonly localHead: string;
	readonly pushedCommits: readonly ZoneGitCommitSummary[];
	readonly remoteHead: string;
}

export interface ZoneGitPushOptions extends ZoneGitReadConfig {
	readonly expectedHead: string;
}

export class ZoneGitConflictError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = 'ZoneGitConflictError';
	}
}

export class ZoneGitProtectedBranchError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = 'ZoneGitProtectedBranchError';
	}
}

function isLocalRemoteUrl(remoteUrl: string): boolean {
	return path.isAbsolute(remoteUrl) || remoteUrl.startsWith('file://');
}

function buildRemoteUrl(options: {
	readonly githubToken?: string;
	readonly remoteUrl: string;
}): string {
	if (isLocalRemoteUrl(options.remoteUrl)) {
		return options.remoteUrl;
	}
	if (!options.githubToken) {
		throw new Error('zoneGit remote requires githubToken for GitHub pushes.');
	}
	return buildGithubTokenUrl(options.remoteUrl, options.githubToken);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function gitBranchPatternMatches(pattern: string, branch: string): boolean {
	const regex = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`, 'u');
	return regex.test(branch);
}

function assertZoneGitPushBranchAllowed(options: {
	readonly branch: string;
	readonly defaultBranch?: string;
	readonly protectedBranches?: readonly string[];
	readonly protectedBranchPatterns?: readonly string[];
	readonly zoneId: string;
}): void {
	const protectedBranchNames = new Set([
		...defaultProtectedZoneGitPushBranchNames,
		...(options.defaultBranch === undefined ? [] : [options.defaultBranch]),
		...(options.protectedBranches ?? []),
	]);
	const protectedBranchPattern = options.protectedBranchPatterns?.find((pattern) =>
		gitBranchPatternMatches(pattern, options.branch),
	);
	if (protectedBranchNames.has(options.branch) || protectedBranchPattern !== undefined) {
		const policyDescription =
			protectedBranchPattern === undefined
				? `protected branch '${options.branch}'`
				: `protected branch pattern '${protectedBranchPattern}'`;
		throw new ZoneGitProtectedBranchError(
			`Zone Git push for zone '${options.zoneId}' refuses ${policyDescription}. Configure zoneGit.remote.branch to a non-protected branch.`,
		);
	}
}

function buildGitArgs(options: {
	readonly args: readonly string[];
	readonly gitDir: string;
	readonly workTree: string;
}): readonly string[] {
	return [
		'-c',
		'core.hooksPath=/dev/null',
		`--git-dir=${options.gitDir}`,
		`--work-tree=${options.workTree}`,
		...options.args,
	];
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
			return false;
		}
		throw error;
	}
}

async function unlinkFileIfExists(filePath: string): Promise<void> {
	try {
		await unlink(filePath);
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
			return;
		}
		throw error;
	}
}

async function git(options: {
	readonly args: readonly string[];
	readonly gitDir: string;
	readonly reject?: boolean;
	readonly workTree: string;
}): Promise<GitCommandResult> {
	const result = await execa(
		'git',
		buildGitArgs({
			args: options.args,
			gitDir: options.gitDir,
			workTree: options.workTree,
		}),
		{
			reject: false,
			timeout: GIT_OPERATION_TIMEOUT_MS,
		},
	);
	const exitCode = typeof result.exitCode === 'number' ? result.exitCode : 128;
	const normalized = {
		stdout: result.stdout,
		stderr:
			typeof result.exitCode === 'number'
				? result.stderr
				: `${result.stderr}\ngit ${options.args.join(' ')} terminated without an exit code`.trim(),
		exitCode,
	};
	const scrubbed = {
		...normalized,
		stdout: scrubGithubTokenFromOutput(normalized.stdout),
		stderr: scrubGithubTokenFromOutput(normalized.stderr),
	};
	if (options.reject === true && scrubbed.exitCode !== 0) {
		throw new Error(
			scrubGithubTokenFromOutput(
				`git ${options.args.join(' ')} failed\n${scrubbed.stdout}\n${scrubbed.stderr}`.trim(),
			),
		);
	}
	return scrubbed;
}

async function gitStdout(options: {
	readonly args: readonly string[];
	readonly gitDir: string;
	readonly workTree: string;
}): Promise<string> {
	return (
		await git({
			args: options.args,
			gitDir: options.gitDir,
			reject: true,
			workTree: options.workTree,
		})
	).stdout.trim();
}

async function maybeGitStdout(options: {
	readonly args: readonly string[];
	readonly gitDir: string;
	readonly workTree: string;
}): Promise<string | null> {
	const result = await git({
		args: options.args,
		gitDir: options.gitDir,
		workTree: options.workTree,
	});
	return result.exitCode === 0 ? result.stdout.trim() : null;
}

function parseCommitSummaries(output: string): readonly ZoneGitCommitSummary[] {
	if (output.trim().length === 0) {
		return [];
	}
	return output
		.trim()
		.split('\n')
		.map((line): ZoneGitCommitSummary => {
			const [sha = '', subject = ''] = line.split('\t');
			if (!sha) {
				throw new Error(`Failed to parse zone Git commit summary line: '${line}'.`);
			}
			return { sha, subject };
		});
}

async function fetchRemoteBranch(
	options: ZoneGitReadConfig & { readonly gitDir: string },
): Promise<void> {
	const remoteUrl = buildRemoteUrl(options);
	const result = await git({
		args: [
			'fetch',
			'--prune',
			remoteUrl,
			`+refs/heads/${options.branch}:refs/remotes/origin/${options.branch}`,
		],
		gitDir: options.gitDir,
		workTree: options.zoneFilesDir,
	});
	if (result.exitCode === 0) {
		return;
	}
	if (result.stderr.includes("couldn't find remote ref")) {
		await git({
			args: ['update-ref', '-d', `refs/remotes/origin/${options.branch}`],
			gitDir: options.gitDir,
			workTree: options.zoneFilesDir,
		});
		return;
	}
	throw new Error(`git fetch ${options.branch} failed\n${result.stdout}\n${result.stderr}`.trim());
}

async function readHead(options: {
	readonly gitDir: string;
	readonly ref: string;
	readonly workTree: string;
}): Promise<string | null> {
	return await maybeGitStdout({
		args: ['rev-parse', '--verify', options.ref],
		gitDir: options.gitDir,
		workTree: options.workTree,
	});
}

async function countCommits(options: {
	readonly gitDir: string;
	readonly range: string;
	readonly workTree: string;
}): Promise<number> {
	const stdout = await gitStdout({
		args: ['rev-list', '--count', options.range],
		gitDir: options.gitDir,
		workTree: options.workTree,
	});
	return Number.parseInt(stdout, 10);
}

export async function ensureZoneGitRepository(options: ZoneGitReadConfig): Promise<void> {
	const zoneGitPaths = resolveZoneGitPaths({
		runtimeDir: options.runtimeDir,
		zoneId: options.zoneId,
	});
	await mkdir(zoneGitPaths.hostZoneGitRoot, { recursive: true });
	if (!(await pathExists(zoneGitPaths.hostGitDir))) {
		await unlinkFileIfExists(path.join(options.zoneFilesDir, '.git'));
		await execa(
			'git',
			[
				'init',
				`--separate-git-dir=${zoneGitPaths.hostGitDir}`,
				`--initial-branch=${options.branch}`,
				options.zoneFilesDir,
			],
			{
				reject: true,
				timeout: GIT_OPERATION_TIMEOUT_MS,
			},
		);
	}
	await writeFile(
		path.join(options.zoneFilesDir, '.git'),
		`gitdir: ${OPENCLAW_ZONE_GIT_GUEST_DIR}\n`,
		{
			encoding: 'utf8',
			mode: 0o644,
		},
	);
	await git({
		args: ['symbolic-ref', 'HEAD', `refs/heads/${options.branch}`],
		gitDir: zoneGitPaths.hostGitDir,
		reject: true,
		workTree: options.zoneFilesDir,
	});
	await git({
		args: ['config', 'core.worktree', '/zone'],
		gitDir: zoneGitPaths.hostGitDir,
		reject: true,
		workTree: options.zoneFilesDir,
	});
	await git({
		args: ['config', 'commit.gpgsign', 'false'],
		gitDir: zoneGitPaths.hostGitDir,
		reject: true,
		workTree: options.zoneFilesDir,
	});
	await git({
		args: ['config', 'core.hooksPath', '/dev/null'],
		gitDir: zoneGitPaths.hostGitDir,
		reject: true,
		workTree: options.zoneFilesDir,
	});
	const originUrl = await maybeGitStdout({
		args: ['remote', 'get-url', 'origin'],
		gitDir: zoneGitPaths.hostGitDir,
		workTree: options.zoneFilesDir,
	});
	await git({
		args:
			originUrl === null
				? ['remote', 'add', 'origin', options.remoteUrl]
				: ['remote', 'set-url', 'origin', options.remoteUrl],
		gitDir: zoneGitPaths.hostGitDir,
		reject: true,
		workTree: options.zoneFilesDir,
	});
}

export async function getZoneGitStatus(options: ZoneGitReadConfig): Promise<ZoneGitStatus> {
	const zoneGitPaths = resolveZoneGitPaths({
		runtimeDir: options.runtimeDir,
		zoneId: options.zoneId,
	});
	if (!(await pathExists(zoneGitPaths.hostGitDir))) {
		return {
			aheadOfRemote: 0,
			behindRemote: 0,
			branch: options.branch,
			dirty: false,
			initialized: false,
			kind: 'uninitialized',
			localHead: null,
			remoteHead: null,
		};
	}
	await fetchRemoteBranch({ ...options, gitDir: zoneGitPaths.hostGitDir });
	const statusOutput = await gitStdout({
		args: ['status', '--porcelain'],
		gitDir: zoneGitPaths.hostGitDir,
		workTree: options.zoneFilesDir,
	});
	const localHead = await readHead({
		gitDir: zoneGitPaths.hostGitDir,
		ref: 'HEAD',
		workTree: options.zoneFilesDir,
	});
	const remoteRef = `refs/remotes/origin/${options.branch}`;
	const remoteHead = await readHead({
		gitDir: zoneGitPaths.hostGitDir,
		ref: remoteRef,
		workTree: options.zoneFilesDir,
	});
	let aheadOfRemote = 0;
	let behindRemote = 0;
	if (localHead && remoteHead) {
		const counts = await gitStdout({
			args: ['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`],
			gitDir: zoneGitPaths.hostGitDir,
			workTree: options.zoneFilesDir,
		});
		const [aheadText = '0', behindText = '0'] = counts.split(/\s+/u);
		aheadOfRemote = Number.parseInt(aheadText, 10);
		behindRemote = Number.parseInt(behindText, 10);
	} else if (localHead) {
		aheadOfRemote = await countCommits({
			gitDir: zoneGitPaths.hostGitDir,
			range: 'HEAD',
			workTree: options.zoneFilesDir,
		});
	}

	return {
		aheadOfRemote,
		behindRemote,
		branch: options.branch,
		dirty: statusOutput.length > 0,
		initialized: true,
		kind: 'initialized',
		localHead,
		remoteHead,
	};
}

export async function pushZoneGit(options: ZoneGitPushOptions): Promise<ZoneGitPushResult> {
	const zoneGitPaths = resolveZoneGitPaths({
		runtimeDir: options.runtimeDir,
		zoneId: options.zoneId,
	});
	if (!(await pathExists(zoneGitPaths.hostGitDir))) {
		throw new Error(`Zone Git repository for zone '${options.zoneId}' is not initialized.`);
	}
	const status = await getZoneGitStatus(options);
	if (!status.localHead) {
		throw new Error(
			`Zone Git repository for zone '${options.zoneId}' has no local commits to push.`,
		);
	}
	if (status.localHead !== options.expectedHead) {
		throw new ZoneGitConflictError(
			`Zone Git repository for zone '${options.zoneId}' local HEAD '${status.localHead}' does not match expectedHead '${options.expectedHead}'.`,
		);
	}
	assertZoneGitPushBranchAllowed({
		branch: options.branch,
		...(options.defaultBranch === undefined ? {} : { defaultBranch: options.defaultBranch }),
		...(options.protectedBranches === undefined
			? {}
			: { protectedBranches: options.protectedBranches }),
		...(options.protectedBranchPatterns === undefined
			? {}
			: { protectedBranchPatterns: options.protectedBranchPatterns }),
		zoneId: options.zoneId,
	});
	const remoteRef = `refs/remotes/origin/${options.branch}`;
	const commitRange = status.remoteHead ? `${remoteRef}..${status.localHead}` : status.localHead;
	const pushedCommits = parseCommitSummaries(
		await gitStdout({
			args: ['log', '--reverse', `--format=%H%x09%s`, commitRange],
			gitDir: zoneGitPaths.hostGitDir,
			workTree: options.zoneFilesDir,
		}),
	);
	await git({
		args: ['push', buildRemoteUrl(options), `${status.localHead}:refs/heads/${options.branch}`],
		gitDir: zoneGitPaths.hostGitDir,
		reject: true,
		workTree: options.zoneFilesDir,
	});
	await fetchRemoteBranch({ ...options, gitDir: zoneGitPaths.hostGitDir });
	const remoteHead = await readHead({
		gitDir: zoneGitPaths.hostGitDir,
		ref: remoteRef,
		workTree: options.zoneFilesDir,
	});
	if (!remoteHead) {
		throw new Error(`Zone Git push for zone '${options.zoneId}' did not produce remote head.`);
	}
	return {
		branch: options.branch,
		localHead: status.localHead,
		pushedCommits,
		remoteHead,
	};
}
