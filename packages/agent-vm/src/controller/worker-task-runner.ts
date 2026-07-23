import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
	appendEvent,
	computeTotalTaskTimeoutMs,
	resolveWorkerConfigInstructionReferences,
	workerConfigDraftSchema,
	workerConfigSchema,
	type TaskEvent,
	type WorkerConfig,
	type WorkerConfigDraft,
} from '@agent-vm/agent-vm-worker';
import type {
	ManagedVmExactProcessTerminationCapability,
	ManagedVmFactory,
	ManagedVmImageCapability,
	ManagedVmMount,
} from '@agent-vm/managed-vm';
import type { SecretResolver } from '@agent-vm/secret-management';
import { execa } from 'execa';
import { z } from 'zod';

import { loadJsonConfigFile } from '../config/json-config-file.js';
import {
	workerTaskResourcesSchema,
	type ExternalResources,
	type ResolvedRepoResourcesDescription,
	workerTaskControllerRequestSchema,
	type WorkerTaskControllerRequest,
	type WorkerTaskControllerRequestInput,
} from '../config/resource-contracts/index.js';
import type { LoadedSystemConfig, SystemConfig } from '../config/system-config.js';
import { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import type {
	DirectProcessGatewayZoneStartResult,
	GatewayZone,
} from '../gateway/gateway-zone-support.js';
import {
	assertWorkerRuntimeRecordMatchesLiveGateway,
	loadWorkerRuntimeRecord,
} from '../gateway/worker-runtime-record.js';
import { loadRepoResourceDescriptionContract } from '../resources/repo-resource-contract-loader.js';
import {
	startRepoResourceProviders,
	stopRepoResourceProviders,
	type SelectedRepoResources,
	type StartedRepoResourceProvider,
} from '../resources/repo-resource-provider-runner.js';
import { compileResourceOverlay } from '../resources/resource-compiler.js';
import { resolveTaskResources } from '../resources/resource-resolver.js';
import type { ProcessIdentity } from '../shared/managed-vm-process.js';
import type { ActiveWorkerTask } from './active-task-registry.js';
import { createHostGitDir, createVmWorkPath } from './active-task-registry.js';
import {
	buildWorkerControlEndpoint,
	buildWorkerControlEnvironment,
	connectWorkerControlSession as connectWorkerControlSessionDefault,
	createControlSessionDispatcher,
	createControlSessionFenceRegistry,
	createWorkerControlDomainHandler,
	createWorkerControlSessionMaterial,
	recordControlSessionDisconnected,
	recordControlSessionReconnected,
	classifyControlSessionDeathGrace,
	type ControlSessionDeathGraceState,
	type ControlSessionClient,
	type WorkerControlRpcOperations,
} from './control-session/index.js';
import type { ControllerWorkerTaskRuntimeRecordTarget } from './durable-state/controller-state-record-paths.js';
import { buildGithubAuthConfigArgs, scrubGithubTokenFromOutput } from './git-auth-support.js';
import {
	buildResolvedRuntimeResources,
	buildRuntimeInstructions,
} from './runtime-instructions-builder.js';
import { buildTaskConfigFromPreparedInput } from './task-config-builder.js';
import type { GatewayVmLifecycleAuthority } from './vm-ownership/gateway-vm-lifecycle-authority.js';
import type {
	GatewayEpochIdentity,
	GatewayEpochSeed,
} from './vm-ownership/vm-ownership-contracts.js';

type WorkerTaskZoneConfig = LoadedSystemConfig['zones'][number];

const workerPackageTarballsEnv = 'AGENT_VM_WORKER_PACKAGE_TARBALLS_JSON';

function createStandaloneWorkerVmLifecycleAuthority(options: {
	readonly controllerEpoch: string;
	readonly taskId: string;
	readonly zoneId: string;
}): GatewayVmLifecycleAuthority {
	const gatewaySeed = {
		bootId: `worker-task-${options.taskId}`,
		controllerEpoch: options.controllerEpoch,
		gatewayEpochId: crypto.randomUUID(),
		generationId: crypto.randomUUID(),
		zoneId: options.zoneId,
	} satisfies GatewayEpochSeed;
	let gatewayIdentity: GatewayEpochIdentity | undefined;
	let seedAbandonmentInFlight: Promise<void> | undefined;
	let seedAbandonmentRequested = false;
	let seedAbandoned = false;
	let destroyed = false;

	return {
		gatewaySeed,
		get gatewayIdentity(): GatewayEpochIdentity | undefined {
			return gatewayIdentity === undefined ? undefined : structuredClone(gatewayIdentity);
		},
		abandonUnattachedGatewaySeedAfter(cleanupOwnedResources): Promise<void> {
			if (gatewayIdentity !== undefined) {
				return Promise.reject(
					new Error(`Worker task '${options.taskId}' VM lifecycle is already attached.`),
				);
			}
			if (seedAbandoned) {
				return Promise.resolve();
			}
			if (seedAbandonmentInFlight !== undefined) {
				return seedAbandonmentInFlight;
			}
			seedAbandonmentRequested = true;
			const abandonmentAttempt = (async (): Promise<void> => {
				await cleanupOwnedResources();
				seedAbandoned = true;
			})();
			const trackedAbandonment = abandonmentAttempt.finally(() => {
				if (seedAbandonmentInFlight === trackedAbandonment) {
					seedAbandonmentInFlight = undefined;
				}
			});
			seedAbandonmentInFlight = trackedAbandonment;
			return trackedAbandonment;
		},
		attachGatewayVm(gatewayVmId): GatewayEpochIdentity {
			if (seedAbandonmentRequested) {
				throw new Error(`Worker task '${options.taskId}' VM lifecycle has begun seed abandonment.`);
			}
			if (gatewayIdentity !== undefined) {
				throw new Error(`Worker task '${options.taskId}' VM lifecycle is already attached.`);
			}
			gatewayIdentity = { ...gatewaySeed, gatewayVmId };
			return structuredClone(gatewayIdentity);
		},
		async containPendingCreate(containmentOptions): Promise<void> {
			const unstartedVm = await containmentOptions.pendingCreate;
			await containmentOptions.closeLateCreatedVm(unstartedVm);
		},
		async destroyLive(destroyWorkerVm): Promise<void> {
			if (gatewayIdentity === undefined) {
				throw new Error(`Worker task '${options.taskId}' VM lifecycle is not attached.`);
			}
			if (destroyed) {
				return;
			}
			await destroyWorkerVm();
			destroyed = true;
		},
	};
}

const workerPackageTarballSchema = z
	.object({
		packageName: z.string().min(1),
		sourcePath: z.string().min(1),
	})
	.strict();

const workerPackageTarballsSchema = z.array(workerPackageTarballSchema).min(1);
type WorkerPackageTarball = z.infer<typeof workerPackageTarballSchema>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, override: unknown): unknown {
	if (Array.isArray(base) || Array.isArray(override)) {
		return override ?? base;
	}
	if (isPlainObject(base) && isPlainObject(override)) {
		const keys = new Set([...Object.keys(base), ...Object.keys(override)]);
		const mergedEntries = [...keys].map((key) => [key, deepMerge(base[key], override[key])]);
		return Object.fromEntries(mergedEntries);
	}
	return override ?? base;
}

function writeStderr(message: string): void {
	process.stderr.write(`${message}\n`);
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

interface LoadedRepoResourceDescription {
	readonly description: ResolvedRepoResourcesDescription;
	readonly repoId: string;
	readonly repoUrl: string;
}

function selectExternalResourcesForRepo(options: {
	readonly description: ResolvedRepoResourcesDescription;
	readonly externalResources: ExternalResources;
}): SelectedRepoResources {
	return Object.fromEntries(
		Object.keys(options.description.requires).flatMap((resourceName) => {
			const externalResource = options.externalResources[resourceName];
			return externalResource
				? [
						[
							resourceName,
							{
								binding: externalResource.binding,
								target: externalResource.target,
							},
						] as const,
					]
				: [];
		}),
	);
}

const taskStatusResponseSchema = z
	.object({
		status: z.string(),
	})
	.passthrough();
const GIT_CLONE_TIMEOUT_MS = 120_000;
const GIT_METADATA_TIMEOUT_MS = 30_000;

async function loadJsonObjectFile(
	filePath: string,
	label: string,
): Promise<Record<string, unknown>> {
	const parsed = await loadJsonConfigFile(filePath);
	if (!isPlainObject(parsed)) {
		throw new Error(`${label} must be a JSON object`);
	}
	return parsed;
}

function isFileNotFoundError(error: unknown): boolean {
	return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

async function readJsonObjectFile(
	filePath: string,
	options: { readonly missingValue?: Record<string, unknown>; readonly label: string },
): Promise<Record<string, unknown>> {
	try {
		return await loadJsonObjectFile(filePath, options.label);
	} catch (error) {
		if (!isFileNotFoundError(error)) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Invalid ${options.label}: ${message}`, { cause: error });
		}
	}

	if (path.basename(filePath) === 'config.json') {
		const jsoncFilePath = path.join(path.dirname(filePath), 'config.jsonc');
		try {
			return await loadJsonObjectFile(jsoncFilePath, options.label);
		} catch (jsoncError) {
			if (!isFileNotFoundError(jsoncError)) {
				const message = jsoncError instanceof Error ? jsoncError.message : String(jsoncError);
				throw new Error(`Invalid ${options.label}: ${message}`, { cause: jsoncError });
			}
			if (options.missingValue !== undefined) {
				return options.missingValue;
			}
			throw new Error(`${options.label} file not found at ${filePath}`, { cause: jsoncError });
		}
	}

	if (options.missingValue !== undefined) {
		return options.missingValue;
	}
	throw new Error(`${options.label} file not found at ${filePath}`);
}

async function materializeRepoAgentVmDirectory(options: {
	readonly baseBranch: string;
	readonly gitDir: string;
	readonly metadataDir: string;
	readonly repoUrl: string;
}): Promise<void> {
	await fs.mkdir(options.metadataDir, { recursive: true });
	const metadataProbeResult = await execa(
		'git',
		[
			'-c',
			'core.hooksPath=/dev/null',
			`--git-dir=${options.gitDir}`,
			'ls-tree',
			'--name-only',
			options.baseBranch,
			'--',
			'.agent-vm',
		],
		{ reject: false, timeout: GIT_METADATA_TIMEOUT_MS },
	);
	if (typeof metadataProbeResult.exitCode !== 'number') {
		const output = `${metadataProbeResult.stdout}\n${metadataProbeResult.stderr}`.trim();
		throw new Error(
			`Failed to probe .agent-vm metadata from ${options.repoUrl}: git ls-tree terminated without an exit code\n${scrubGithubTokenFromOutput(output)}`.trim(),
		);
	}
	if (metadataProbeResult.exitCode !== 0) {
		const output = `${metadataProbeResult.stdout}\n${metadataProbeResult.stderr}`.trim();
		throw new Error(
			`Failed to probe .agent-vm metadata from ${options.repoUrl}: ${scrubGithubTokenFromOutput(output)}`,
		);
	}
	if (metadataProbeResult.stdout.trim().length === 0) {
		await fs.mkdir(path.join(options.metadataDir, '.agent-vm'), { recursive: true });
		return;
	}
	const archivePath = path.join(options.metadataDir, 'agent-vm-metadata.tar');
	const archiveResult = await execa(
		'git',
		[
			'-c',
			'core.hooksPath=/dev/null',
			`--git-dir=${options.gitDir}`,
			'archive',
			'--format=tar',
			`--output=${archivePath}`,
			options.baseBranch,
			'.agent-vm',
		],
		{ reject: false, timeout: GIT_METADATA_TIMEOUT_MS },
	);
	if (typeof archiveResult.exitCode !== 'number') {
		const output = `${archiveResult.stdout}\n${archiveResult.stderr}`.trim();
		throw new Error(
			`Failed to archive .agent-vm metadata from ${options.repoUrl}: git archive terminated without an exit code\n${scrubGithubTokenFromOutput(output)}`.trim(),
		);
	}
	if (archiveResult.exitCode !== 0) {
		const output = `${archiveResult.stdout}\n${archiveResult.stderr}`.trim();
		throw new Error(
			`Failed to archive .agent-vm metadata from ${options.repoUrl}: ${scrubGithubTokenFromOutput(output)}`,
		);
	}
	try {
		await execa('tar', ['-xf', archivePath, '-C', options.metadataDir], {
			reject: true,
			timeout: GIT_METADATA_TIMEOUT_MS,
		});
	} finally {
		await fs.rm(archivePath, { force: true });
	}
}

async function copyLocalWorkerTarballIfConfigured(stateDir: string): Promise<void> {
	const localWorkerTarballPath = process.env.AGENT_VM_WORKER_TARBALL_PATH;
	if (!localWorkerTarballPath) {
		return;
	}

	await fs.copyFile(localWorkerTarballPath, path.join(stateDir, 'agent-vm-worker.tgz'));
}

function localWorkerPackageDependencyName(packageName: string): string {
	return packageName.startsWith('@') ? packageName : `@agent-vm/${packageName}`;
}

function parseWorkerPackageTarballsEnv(rawTarballs: string): readonly WorkerPackageTarball[] {
	const parsedJson: unknown = JSON.parse(rawTarballs);
	return workerPackageTarballsSchema.parse(parsedJson);
}

function renderWorkerPackageTarballsManifest(tarballs: readonly WorkerPackageTarball[]): string {
	const dependencies: Record<string, string> = {};
	for (const tarball of tarballs) {
		dependencies[localWorkerPackageDependencyName(tarball.packageName)] =
			`file:/state/agent-vm-worker-packages/${path.basename(tarball.sourcePath)}`;
	}
	return `${JSON.stringify(
		{
			private: true,
			dependencies,
			pnpm: {
				overrides: dependencies,
			},
		},
		null,
		2,
	)}\n`;
}

async function copyLocalWorkerPackageTarballsIfConfigured(stateDir: string): Promise<void> {
	const rawTarballs = process.env[workerPackageTarballsEnv];
	if (rawTarballs === undefined || rawTarballs.length === 0) {
		return;
	}

	const tarballs = parseWorkerPackageTarballsEnv(rawTarballs);
	const packageDirectory = path.join(stateDir, 'agent-vm-worker-packages');
	await fs.mkdir(packageDirectory, { recursive: true });
	await Promise.all(
		tarballs.map(async (tarball) => {
			await fs.copyFile(
				tarball.sourcePath,
				path.join(packageDirectory, path.basename(tarball.sourcePath)),
			);
		}),
	);
	await fs.writeFile(
		path.join(packageDirectory, 'package.json'),
		renderWorkerPackageTarballsManifest(tarballs),
		'utf8',
	);
}

async function writeAgentRuntimeFiles(
	agentVmDir: string,
	files: Readonly<Record<string, string>>,
): Promise<void> {
	await Promise.all(
		Object.entries(files).map(async ([relativePath, content]) => {
			const outputPath = path.join(agentVmDir, relativePath);
			await fs.mkdir(path.dirname(outputPath), { recursive: true });
			await fs.writeFile(outputPath, content, { encoding: 'utf8', mode: 0o644 });
		}),
	);
}

async function replaceRelativeSymlink(linkPath: string, target: string): Promise<void> {
	try {
		await fs.unlink(linkPath);
	} catch (error) {
		if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
			throw error;
		}
	}
	await fs.symlink(target, linkPath);
}

export type WorkerTaskInput = WorkerTaskControllerRequestInput;

export interface PreStartResult {
	readonly taskId: string;
	readonly input: WorkerTaskControllerRequest;
	readonly taskRoot: string;
	readonly taskRuntimeRoot: string;
	readonly workDir: string;
	readonly stateDir: string;
	readonly startedResourceProviders: readonly StartedRepoResourceProvider[];
	readonly environment: Record<string, string>;
	readonly tcpHosts: Record<string, string>;
	readonly vfsMounts: Readonly<Record<string, ManagedVmMount>>;
	readonly repos: readonly {
		readonly repoId: string;
		readonly repoUrl: string;
		readonly baseBranch: string;
		readonly pushPolicy:
			| {
					readonly kind: 'trusted_config';
					readonly defaultBranch: string;
					readonly protectedBranches: readonly string[];
					readonly protectedBranchPatterns: readonly string[];
			  }
			| { readonly kind: 'missing' };
		readonly gitDirPath: string;
		readonly hostGitDir: string;
		readonly hostMetadataPath: string;
		readonly workPath: string;
	}[];
	readonly effectiveConfig: WorkerConfig;
}

function deriveRepoDirectoryName(repoUrl: string, usedNames: Set<string>): string {
	const cleanedUrl = repoUrl.replace(/\.git$/, '');
	const baseName = cleanedUrl.split('/').pop()?.trim() ?? 'repo';
	const sanitizedBaseName =
		baseName
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/gu, '-')
			.replace(/^-+|-+$/gu, '') || 'repo';
	let candidate = sanitizedBaseName;
	let counter = 2;
	while (usedNames.has(candidate)) {
		candidate = `${sanitizedBaseName}-${counter}`;
		counter += 1;
	}
	usedNames.add(candidate);
	return candidate;
}

function normalizeWorkerRepoPolicyUrl(repoUrl: string): string {
	try {
		const parsedUrl = new URL(repoUrl);
		parsedUrl.protocol = parsedUrl.protocol.toLowerCase();
		parsedUrl.hostname = parsedUrl.hostname.toLowerCase();
		parsedUrl.hash = '';
		parsedUrl.search = '';
		parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/u, '').replace(/\.git$/u, '');
		return parsedUrl.toString();
	} catch {
		return repoUrl.replace(/\/+$/u, '').replace(/\.git$/u, '');
	}
}

function trustedWorkerRepoPushPolicyFor(options: {
	readonly repoUrl: string;
	readonly zoneConfig: WorkerTaskZoneConfig;
}): PreStartResult['repos'][number]['pushPolicy'] {
	if (options.zoneConfig.gateway.type !== 'worker') {
		return { kind: 'missing' };
	}
	const normalizedRepoUrl = normalizeWorkerRepoPolicyUrl(options.repoUrl);
	const policy = options.zoneConfig.gateway.repoPushPolicies?.find(
		(candidate) => normalizeWorkerRepoPolicyUrl(candidate.repoUrl) === normalizedRepoUrl,
	);
	if (policy === undefined) {
		return { kind: 'missing' };
	}
	return {
		kind: 'trusted_config',
		defaultBranch: policy.defaultBranch,
		protectedBranches: policy.protectedBranches,
		protectedBranchPatterns: policy.protectedBranchPatterns,
	};
}

export interface WorkerTaskResult {
	readonly taskId: string;
	readonly finalState: unknown;
	readonly taskRoot: string;
}

export async function preStartGateway(
	taskInput: WorkerTaskInput,
	zoneConfig: GatewayZone,
	options: { readonly githubToken?: string; readonly zoneRuntimeDir?: string } = {},
): Promise<PreStartResult> {
	const parsedTaskInput = workerTaskControllerRequestSchema.parse(taskInput);
	const taskId = crypto.randomUUID();
	const taskRoot = path.join(zoneConfig.gateway.stateDir, 'tasks', taskId);
	const zoneRuntimeDir =
		options.zoneRuntimeDir ?? path.join(path.dirname(zoneConfig.gateway.stateDir), 'runtime');
	const taskRuntimeRoot = path.join(zoneRuntimeDir, 'worker-tasks', taskId);
	const workDir = path.join(taskRuntimeRoot, 'work');
	const stateDir = path.join(taskRoot, 'state');
	const agentVmDir = path.join(taskRoot, 'agent-vm');

	let startedResourceProviders: readonly StartedRepoResourceProvider[] = [];
	try {
		await fs.mkdir(workDir, { recursive: true });
		await fs.mkdir(stateDir, { recursive: true });
		await fs.mkdir(agentVmDir, { recursive: true });
		await copyLocalWorkerTarballIfConfigured(stateDir);
		await copyLocalWorkerPackageTarballsIfConfigured(stateDir);

		const gitdirsRoot = path.join(taskRuntimeRoot, 'gitdirs');
		const metadataRoot = path.join(taskRuntimeRoot, 'repo-metadata');
		const usedRepoNames = new Set<string>();
		const preparedRepoTargets = parsedTaskInput.repos.map((repo) => {
			const repoId = deriveRepoDirectoryName(repo.repoUrl, usedRepoNames);
			return {
				...repo,
				repoId,
				gitDirPath: `/gitdirs/${repoId}.git`,
				hostGitDir: path.join(gitdirsRoot, `${repoId}.git`),
				hostMetadataPath: path.join(metadataRoot, repoId),
				workPath: `/work/repos/${repoId}`,
			};
		});
		const cloneResults = await Promise.allSettled(
			preparedRepoTargets.map(async (repo) => {
				const authArgs = options.githubToken ? buildGithubAuthConfigArgs(options.githubToken) : [];
				const cloneArgs = [
					...authArgs,
					'-c',
					'core.hooksPath=/dev/null',
					'clone',
					'--bare',
					'--branch',
					repo.baseBranch,
					repo.repoUrl,
					repo.hostGitDir,
				];
				let cloneResult: {
					readonly exitCode?: number;
					readonly stderr: string;
					readonly stdout: string;
				};
				try {
					cloneResult = await execa('git', cloneArgs, {
						reject: false,
						timeout: GIT_CLONE_TIMEOUT_MS,
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new Error(
						`git clone failed for ${repo.repoUrl}: ${scrubGithubTokenFromOutput(message)}`,
						{ cause: error },
					);
				}
				if ((cloneResult.exitCode ?? -1) !== 0) {
					const errorDetail = scrubGithubTokenFromOutput(
						`${cloneResult.stdout}\n${cloneResult.stderr}`.trim(),
					);
					throw new Error(`git clone failed for ${repo.repoUrl}: ${errorDetail}`.trim());
				}
				for (const [key, value] of [
					['core.bare', 'false'],
					['user.email', 'agent-vm-worker@agent-vm'],
					['user.name', 'agent-vm-worker'],
					['http.version', 'HTTP/1.1'],
					['commit.gpgsign', 'false'],
				] as const) {
					// Git serializes config writes through .git/config.lock; keep these ordered.
					// oxlint-disable-next-line eslint/no-await-in-loop
					await execa(
						'git',
						[
							'-c',
							'core.hooksPath=/dev/null',
							`--git-dir=${repo.hostGitDir}`,
							'config',
							key,
							value,
						],
						{
							reject: true,
							timeout: 10_000,
						},
					);
				}
				await materializeRepoAgentVmDirectory({
					baseBranch: repo.baseBranch,
					gitDir: repo.hostGitDir,
					metadataDir: repo.hostMetadataPath,
					repoUrl: repo.repoUrl,
				});
				return {
					repoId: repo.repoId,
					repoUrl: repo.repoUrl,
					baseBranch: repo.baseBranch,
					pushPolicy: trustedWorkerRepoPushPolicyFor({
						repoUrl: repo.repoUrl,
						zoneConfig,
					}),
					gitDirPath: repo.gitDirPath,
					hostGitDir: repo.hostGitDir,
					hostMetadataPath: repo.hostMetadataPath,
					workPath: repo.workPath,
				};
			}),
		);
		const rejectedCloneResults = cloneResults.filter(
			(result): result is PromiseRejectedResult => result.status === 'rejected',
		);
		if (rejectedCloneResults.length > 0) {
			const cloneFailureErrors = rejectedCloneResults.map((result) => toError(result.reason));
			const cloneFailureDetails = rejectedCloneResults
				.map((result) =>
					result.reason instanceof Error ? result.reason.message : String(result.reason),
				)
				.join('\n');
			throw new AggregateError(
				cloneFailureErrors,
				`Failed to prepare ${rejectedCloneResults.length} repo clone(s).\n${cloneFailureDetails}`,
			);
		}
		const clonedRepos: {
			readonly repoId: string;
			readonly repoUrl: string;
			readonly baseBranch: string;
			readonly pushPolicy: PreStartResult['repos'][number]['pushPolicy'];
			readonly gitDirPath: string;
			readonly hostGitDir: string;
			readonly hostMetadataPath: string;
			readonly workPath: string;
		}[] = cloneResults.map((result) => {
			if (result.status === 'rejected') {
				throw result.reason;
			}
			return result.value;
		});

		const primaryRepo = clonedRepos[0] ?? null;
		const projectConfig =
			primaryRepo === null
				? {}
				: await readJsonObjectFile(
						path.join(primaryRepo.hostMetadataPath, '.agent-vm', 'config.json'),
						{
							label: 'project config',
							missingValue: {},
						},
					);
		const baseConfig = await readJsonObjectFile(zoneConfig.gateway.config, {
			label: 'gateway config',
		});
		const resolvedBaseConfig = await resolveWorkerConfigInstructionReferences(baseConfig, {
			configPath: zoneConfig.gateway.config,
		});
		const effectiveConfigDraft = workerConfigDraftSchema.parse(
			deepMerge(resolvedBaseConfig, projectConfig),
		) satisfies WorkerConfigDraft;

		const resources = workerTaskResourcesSchema.parse(parsedTaskInput.resources);
		const allowRepoResources = zoneConfig.resources?.allowRepoResources ?? true;
		const loadedRepoResourceDescriptions =
			allowRepoResources === false
				? []
				: await Promise.all(
						clonedRepos.map(async (repo) => {
							const description = await loadRepoResourceDescriptionContract({
								repoDir: repo.hostMetadataPath,
								repoId: repo.repoId,
								repoUrl: repo.repoUrl,
							});
							return description
								? {
										repoId: repo.repoId,
										repoUrl: repo.repoUrl,
										description,
									}
								: null;
						}),
					);
		const repoResourceDescriptions = loadedRepoResourceDescriptions.filter(
			(description): description is LoadedRepoResourceDescription => description !== null,
		);
		const resolvedResources = resolveTaskResources({
			allowRepoResources,
			externalResources: resources.externalResources,
			repos: repoResourceDescriptions,
		});
		const repoById = new Map(clonedRepos.map((repo) => [repo.repoId, repo]));
		const providerRun = await startRepoResourceProviders({
			taskId,
			repos: repoResourceDescriptions.map((repoDescription) => {
				const repo = repoById.get(repoDescription.repoId);
				if (!repo) {
					throw new Error(`Resource setup references unknown repo '${repoDescription.repoId}'.`);
				}
				return {
					repoId: repoDescription.repoId,
					repoUrl: repoDescription.repoUrl,
					repoDir: repo.hostMetadataPath,
					outputDir: path.join(agentVmDir, 'resources', repoDescription.repoId),
					selectedExternalResources: selectExternalResourcesForRepo({
						description: repoDescription.description,
						externalResources: resolvedResources.externalResources,
					}),
					setupCommand: repoDescription.description.setupCommand,
				};
			}),
			providers: resolvedResources.selectedRepoProviders.map((provider) => {
				const repo = repoById.get(provider.repoId);
				if (!repo) {
					throw new Error(
						`Resolved resource provider references unknown repo '${provider.repoId}'.`,
					);
				}
				return {
					...provider,
					repoDir: repo.hostMetadataPath,
					outputDir: path.join(agentVmDir, 'resources', provider.repoId),
				};
			}),
		});
		startedResourceProviders = providerRun.startedProviders;
		const overlay = compileResourceOverlay({
			externalResources: resolvedResources.externalResources,
			repoFinalizations: providerRun.finalizations,
		});
		const runtime = buildRuntimeInstructions({
			gatewayType: 'worker',
			resolvedResources: buildResolvedRuntimeResources({
				externalResources: resolvedResources.externalResources,
				repoFinalizations: providerRun.finalizations,
			}),
			runtimeAuthHints: zoneConfig.runtimeAuthHints ?? [],
			taskId,
			workDir: '/work/repos',
		});
		const effectiveConfig = workerConfigSchema.parse({
			...effectiveConfigDraft,
			runtimeInstructions: runtime.runtimeInstructions,
		}) satisfies WorkerConfig;
		await writeAgentRuntimeFiles(agentVmDir, runtime.agentRuntimeFiles);
		await replaceRelativeSymlink(path.join(agentVmDir, 'CLAUDE.md'), 'agents.md');
		await fs.writeFile(
			path.join(stateDir, 'effective-worker.json'),
			JSON.stringify(effectiveConfig, null, 2),
			{ encoding: 'utf8', mode: 0o600 },
		);

		return {
			taskId,
			input: parsedTaskInput,
			taskRoot,
			taskRuntimeRoot,
			workDir,
			stateDir,
			startedResourceProviders: providerRun.startedProviders,
			environment: overlay.environment,
			tcpHosts: overlay.tcpHosts,
			vfsMounts: {
				'/gitdirs': {
					access: 'read-write',
					hostPath: gitdirsRoot,
					kind: 'host-directory',
				},
				'/agent-vm': {
					access: 'read-only',
					hostPath: agentVmDir,
					kind: 'host-directory',
				},
			},
			repos: clonedRepos,
			effectiveConfig,
		};
	} catch (error) {
		return await cleanupTaskRootAfterPreparationFailure({
			primaryError: error,
			startedProviders: startedResourceProviders,
			taskId,
			taskRuntimeRoot,
			taskRoot,
		});
	}
}

export async function postStopGateway(
	taskId: string,
	zoneConfig: GatewayZone,
	startedProviders: readonly StartedRepoResourceProvider[] = [],
	options: { readonly zoneRuntimeDir?: string } = {},
): Promise<void> {
	const taskRoot = path.join(zoneConfig.gateway.stateDir, 'tasks', taskId);
	const zoneRuntimeDir =
		options.zoneRuntimeDir ?? path.join(path.dirname(zoneConfig.gateway.stateDir), 'runtime');
	const taskRuntimeRoot = path.join(zoneRuntimeDir, 'worker-tasks', taskId);
	const resourcesDir = path.join(taskRoot, 'agent-vm', 'resources');
	let cleanupError: Error | null = null;
	let runtimeRemovalError: Error | null = null;
	let resourcesRemovalError: Error | null = null;
	try {
		await stopRepoResourceProviders(startedProviders);
	} catch (error) {
		cleanupError = error instanceof Error ? error : new Error(String(error));
	}
	try {
		await fs.rm(resourcesDir, { recursive: true, force: true });
	} catch (error) {
		resourcesRemovalError = error instanceof Error ? error : new Error(String(error));
	}
	try {
		await fs.rm(taskRuntimeRoot, { recursive: true, force: true });
	} catch (error) {
		runtimeRemovalError = error instanceof Error ? error : new Error(String(error));
	}
	const errors = [cleanupError, resourcesRemovalError, runtimeRemovalError].filter(
		(error): error is Error => error !== null,
	);
	if (errors.length > 1) {
		const aggregateError = new AggregateError(
			errors,
			`Failed to stop Docker services and prune task resources/work for ${taskId}.`,
		);
		aggregateError.cause = errors[0];
		throw aggregateError;
	}
	if (errors.length === 1) {
		throw errors[0];
	}
}

async function cleanupTaskRootAfterPreparationFailure(options: {
	readonly primaryError: unknown;
	readonly startedProviders: readonly StartedRepoResourceProvider[];
	readonly taskId: string;
	readonly taskRuntimeRoot?: string;
	readonly taskRoot: string;
}): Promise<never> {
	const errors = [toError(options.primaryError)];
	try {
		await stopRepoResourceProviders(options.startedProviders);
	} catch (cleanupError) {
		errors.push(toError(cleanupError));
	}
	try {
		await fs.rm(options.taskRoot, { recursive: true, force: true });
	} catch (removeError) {
		errors.push(toError(removeError));
	}
	if (options.taskRuntimeRoot !== undefined) {
		try {
			await fs.rm(options.taskRuntimeRoot, { recursive: true, force: true });
		} catch (removeError) {
			errors.push(toError(removeError));
		}
	}
	if (errors.length === 1) {
		throw errors[0];
	}
	const aggregateError = new AggregateError(
		errors,
		`Failed to clean up task ${options.taskId} after preparation failure.`,
	);
	aggregateError.cause = errors[0];
	throw aggregateError;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
	const response = await fetch(url, init);
	if (!response.ok) {
		const responseBody = await response.text();
		throw new Error(
			`${init?.method ?? 'GET'} ${url} failed with ${String(response.status)}: ${responseBody}`,
		);
	}
	return await response.json();
}

export interface PreparedWorkerTask {
	readonly taskId: string;
	readonly taskRoot: string;
	readonly zoneId: string;
	readonly input: WorkerTaskControllerRequest;
	readonly preStartResult: PreStartResult;
	readonly taskZoneConfig: GatewayZone;
	readonly zone: GatewayZone;
	readonly eventLogPath: string;
	readonly recordEvent: (event: TaskEvent) => Promise<void>;
}

export interface PrepareWorkerTaskOptions {
	readonly input: WorkerTaskInput;
	readonly systemConfig: SystemConfig;
	readonly zoneId: string;
	readonly githubToken?: string;
	readonly onTaskPrepared?: (task: ActiveWorkerTask) => void | Promise<void>;
}

export interface ExecuteWorkerTaskOptions {
	readonly controllerEpoch: string;
	readonly secretResolver: SecretResolver;
	readonly systemConfig: LoadedSystemConfig;
	readonly controlSession?: {
		readonly controllerEpoch: string;
		readonly operations: WorkerControlRpcOperations;
	};
	readonly connectWorkerControlSession?: typeof connectWorkerControlSessionDefault;
	readonly managedVmExactProcessTermination: ManagedVmExactProcessTerminationCapability;
	readonly managedVmTerminationSleep?: (delayMs: number) => Promise<void>;
	readonly managedVmFactory: ManagedVmFactory;
	readonly managedVmImages: ManagedVmImageCapability;
	readonly readProcessIdentity?: (pid: number) => Promise<ProcessIdentity | null>;
	readonly pollClock?: WorkerTaskPollClock;
	readonly pollIntervalMs?: number;
	readonly timeoutMs?: number;
	readonly workerRuntimeRecordTarget: ControllerWorkerTaskRuntimeRecordTarget;
	readonly onWorkerTaskIngress?: (
		zoneId: string,
		taskId: string,
		workerIngress: { readonly host: string; readonly port: number },
	) => void | Promise<void>;
	readonly onTaskFinished?: (zoneId: string, taskId: string) => void | Promise<void>;
}

export interface WorkerTaskPollClock {
	readonly now: () => number;
	readonly sleep: (durationMs: number) => Promise<void>;
}

const defaultWorkerTaskPollClock: WorkerTaskPollClock = {
	now: () => performance.now(),
	sleep: async (durationMs: number): Promise<void> => {
		await new Promise((resolve) => setTimeout(resolve, durationMs));
	},
};

function classifyWorkerControlSessionHealth(options: {
	readonly controlSession: ControlSessionClient | undefined;
	readonly deathGraceState: ControlSessionDeathGraceState;
	readonly nowMs: number;
	readonly taskId: string;
}): ControlSessionDeathGraceState {
	if (options.controlSession === undefined) {
		return options.deathGraceState;
	}
	const diagnostics = options.controlSession.getDiagnostics();
	if (diagnostics.ready) {
		return recordControlSessionReconnected({
			previousState: options.deathGraceState,
		});
	}
	const disconnectedState = recordControlSessionDisconnected({
		nowMs: options.nowMs,
		previousState: options.deathGraceState,
	});
	const classification = classifyControlSessionDeathGrace({
		nowMs: options.nowMs,
		state: disconnectedState,
	});
	if (classification.kind === 'recovery_due') {
		throw new Error(
			`Worker control session for task ${options.taskId} exceeded death grace after ${String(classification.elapsedMs)}ms; worker VM recovery is required.`,
		);
	}
	return disconnectedState;
}

export async function prepareWorkerTask(
	options: PrepareWorkerTaskOptions,
): Promise<PreparedWorkerTask> {
	const zone = options.systemConfig.zones.find(
		(candidateZone) => candidateZone.id === options.zoneId,
	);
	if (!zone) {
		throw new Error(`Unknown zone '${options.zoneId}'.`);
	}
	if (zone.gateway.type !== 'worker') {
		throw new Error(`Zone '${options.zoneId}' is not a worker zone.`);
	}

	const preStartOptions = {
		zoneRuntimeDir: zone.gateway.zoneRuntimeDir,
		...(options.githubToken ? { githubToken: options.githubToken } : {}),
	};
	const preStartResult = await preStartGateway(options.input, zone, preStartOptions);
	const parsedInput = preStartResult.input;
	try {
		const taskZoneConfig: GatewayZone = {
			...zone,
			gateway: {
				...zone.gateway,
				stateDir: preStartResult.stateDir,
			},
		};

		const eventLogPath = path.join(
			preStartResult.stateDir,
			'tasks',
			`${preStartResult.taskId}.jsonl`,
		);
		const recordEvent = async (event: TaskEvent): Promise<void> => {
			await appendEvent(eventLogPath, event);
		};
		await recordEvent({
			event: 'task-accepted',
			taskId: preStartResult.taskId,
			config: buildTaskConfigFromPreparedInput({
				taskId: preStartResult.taskId,
				input: parsedInput,
				repos: preStartResult.repos,
				effectiveConfig: preStartResult.effectiveConfig,
			}),
		});

		await options.onTaskPrepared?.({
			taskId: preStartResult.taskId,
			zoneId: options.zoneId,
			taskRoot: preStartResult.taskRoot,
			eventLogPath,
			branchPrefix: preStartResult.effectiveConfig.branchPrefix,
			repos: preStartResult.repos.map((repo) => ({
				repoUrl: repo.repoUrl,
				baseBranch: repo.baseBranch,
				pushPolicy: repo.pushPolicy,
				hostGitDir: createHostGitDir(repo.hostGitDir),
				vmWorkPath: createVmWorkPath(repo.workPath),
			})),
			workerIngress: null,
		});

		return {
			taskId: preStartResult.taskId,
			taskRoot: preStartResult.taskRoot,
			zoneId: options.zoneId,
			input: parsedInput,
			preStartResult,
			taskZoneConfig,
			zone,
			eventLogPath,
			recordEvent,
		};
	} catch (error) {
		return await cleanupTaskRootAfterPreparationFailure({
			primaryError: error,
			startedProviders: preStartResult.startedResourceProviders,
			taskId: preStartResult.taskId,
			taskRuntimeRoot: preStartResult.taskRuntimeRoot,
			taskRoot: preStartResult.taskRoot,
		});
	}
}

export async function executeWorkerTask(
	prepared: PreparedWorkerTask,
	options: ExecuteWorkerTaskOptions,
): Promise<WorkerTaskResult> {
	let gateway: DirectProcessGatewayZoneStartResult | undefined;
	let controlSession: ControlSessionClient | undefined;
	let workerControlDeathGraceState: ControlSessionDeathGraceState = { kind: 'connected' };
	let result: WorkerTaskResult | undefined;
	let primaryError: Error | undefined;
	const workerControlMaterial =
		options.controlSession === undefined
			? undefined
			: createWorkerControlSessionMaterial({
					controllerEpoch: options.controlSession.controllerEpoch,
					taskId: prepared.taskId,
					zoneId: prepared.zoneId,
				});
	if (
		options.workerRuntimeRecordTarget.zoneId !== prepared.zoneId ||
		options.workerRuntimeRecordTarget.taskId !== prepared.taskId
	) {
		throw new Error(
			`Worker runtime record target '${options.workerRuntimeRecordTarget.zoneId}/${options.workerRuntimeRecordTarget.taskId}' does not match prepared task '${prepared.zoneId}/${prepared.taskId}'.`,
		);
	}

	try {
		const startedGateway = await startGatewayZone(
			{
				createVmOwnership: async (ownershipOptions): Promise<GatewayVmLifecycleAuthority> => {
					if (ownershipOptions.kind !== 'standalone') {
						throw new Error(
							`Worker task '${prepared.taskId}' cannot create Gateway-epoch ownership.`,
						);
					}
					return createStandaloneWorkerVmLifecycleAuthority({
						controllerEpoch: options.controllerEpoch,
						taskId: prepared.taskId,
						zoneId: ownershipOptions.zoneId,
					});
				},
				environmentOverride: {
					...prepared.preStartResult.environment,
					...(workerControlMaterial === undefined
						? {}
						: buildWorkerControlEnvironment(workerControlMaterial)),
				},
				secretResolver: options.secretResolver,
				gitReadAllowlistRepos: prepared.preStartResult.repos.map((repo) => repo.repoUrl),
				systemConfig: options.systemConfig,
				tcpHostsOverride: prepared.preStartResult.tcpHosts,
				vfsMountsOverride: prepared.preStartResult.vfsMounts,
				runtimeRecordTarget: options.workerRuntimeRecordTarget,
				zoneId: prepared.zoneId,
				zoneOverride: prepared.taskZoneConfig,
			},
			{
				managedVmFactory: options.managedVmFactory,
				managedVmExactProcessTermination: options.managedVmExactProcessTermination,
				managedVmImages: options.managedVmImages,
				...(options.managedVmTerminationSleep === undefined
					? {}
					: { managedVmTerminationSleep: options.managedVmTerminationSleep }),
			},
		);
		if (startedGateway.executionModel !== 'direct-process') {
			throw new Error(
				`Worker task '${prepared.taskId}' requires the direct-process Gateway lifecycle.`,
			);
		}
		gateway = startedGateway;
		await options.onWorkerTaskIngress?.(prepared.zoneId, prepared.taskId, gateway.ingress);

		const baseUrl = `http://${gateway.ingress.host}:${gateway.ingress.port}`;
		if (workerControlMaterial !== undefined && options.controlSession !== undefined) {
			const sessionFenceRegistry = createControlSessionFenceRegistry();
			const dispatcher = createControlSessionDispatcher({ sessionFenceRegistry });
			dispatcher.register(
				'worker_control',
				createWorkerControlDomainHandler({
					authenticatedTask: { taskId: prepared.taskId },
					observations: {
						onCapacitySnapshot: async () => {},
						onRuntimeObservation: async (payload) => {
							await prepared.recordEvent({
								event: 'worker-control-runtime-observation',
								...(payload.correlation === undefined ? {} : { correlation: payload.correlation }),
								observedAtMs: payload.observedAtMs,
								...(payload.sessionState === undefined
									? {}
									: { sessionState: payload.sessionState }),
								...(payload.state === undefined ? {} : { state: payload.state }),
							});
						},
						onRuntimeStatus: async (payload) => {
							await prepared.recordEvent({
								event: 'worker-control-runtime-status',
								findings: payload.findings,
								observedAtMs: payload.observedAtMs,
								statusKind: payload.statusKind,
							});
						},
					},
					operations: options.controlSession.operations,
				}),
			);
			controlSession = await (
				options.connectWorkerControlSession ?? connectWorkerControlSessionDefault
			)({
				dispatcher,
				endpoint: buildWorkerControlEndpoint(gateway.ingress),
				material: workerControlMaterial,
				sessionFenceRegistry,
			});
		}
		await fetchJson(`${baseUrl}/tasks`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				taskId: prepared.taskId,
				prompt: prepared.input.prompt,
				repos: prepared.preStartResult.repos.map((repo) => ({
					repoUrl: repo.repoUrl,
					baseBranch: repo.baseBranch,
					gitDirPath: repo.gitDirPath,
					workPath: repo.workPath,
				})),
				context: prepared.input.context,
			}),
		});

		const timeoutMs =
			options.timeoutMs ?? computeTotalTaskTimeoutMs(prepared.preStartResult.effectiveConfig);
		const pollClock = options.pollClock ?? defaultWorkerTaskPollClock;
		const pollIntervalMs = options.pollIntervalMs ?? 1000;
		const start = pollClock.now();
		let consecutivePollFailures = 0;
		while (pollClock.now() - start < timeoutMs) {
			let state:
				| {
						readonly status?: string | undefined;
				  }
				| undefined;
			try {
				// Polling task state is intentionally sequential because each request depends on prior status.
				// oxlint-disable-next-line eslint/no-await-in-loop
				const response = await fetchJson(`${baseUrl}/tasks/${prepared.taskId}`);
				state = taskStatusResponseSchema.parse(response);
				consecutivePollFailures = 0;
			} catch (error) {
				if (error instanceof z.ZodError) {
					throw new Error(
						`Worker task status response did not match the expected schema for task ${prepared.taskId}.`,
						{ cause: error },
					);
				}
				consecutivePollFailures += 1;
				const message = error instanceof Error ? error.message : String(error);
				writeStderr(
					`[worker-task-runner] Poll failure ${consecutivePollFailures} for task ${prepared.taskId}: ${message}`,
				);
				if (consecutivePollFailures >= 3) {
					throw new Error(
						`Worker task status polling failed ${String(consecutivePollFailures)} consecutive times for task ${prepared.taskId}; last error: ${message}`,
						{ cause: error },
					);
				}
			}
			if (!state) {
				// Poll retry loop intentionally sleeps before the next serial attempt.
				// oxlint-disable-next-line eslint/no-await-in-loop
				await pollClock.sleep(pollIntervalMs);
				continue;
			}
			if (state.status === 'completed' || state.status === 'failed' || state.status === 'closed') {
				result = {
					taskId: prepared.taskId,
					finalState: state,
					taskRoot: prepared.taskRoot,
				};
				break;
			}
			workerControlDeathGraceState = classifyWorkerControlSessionHealth({
				controlSession,
				deathGraceState: workerControlDeathGraceState,
				nowMs: pollClock.now(),
				taskId: prepared.taskId,
			});
			// The sleep is part of the serial poll loop and cannot be parallelized.
			// oxlint-disable-next-line eslint/no-await-in-loop
			await pollClock.sleep(pollIntervalMs);
		}

		if (!result) {
			throw new Error(`Worker task timed out after ${timeoutMs}ms.`);
		}
	} catch (error) {
		primaryError = toError(error);
	}

	const cleanupErrors: Error[] = [];
	let vmDestructionComplete = gateway === undefined;
	try {
		controlSession?.close();
	} catch (error) {
		cleanupErrors.push(toError(error));
	}
	if (gateway) {
		try {
			const persistedRuntimeRecord = await loadWorkerRuntimeRecord(
				options.workerRuntimeRecordTarget,
			);
			const runtimeRecord = persistedRuntimeRecord;
			if (runtimeRecord === null && gateway.vm.getHostProcessId() !== null) {
				throw new Error(
					`Worker VM '${gateway.vm.id}' has a live runner but no runtime record; refusing unverified cleanup.`,
				);
			}
			if (runtimeRecord !== null) {
				await assertWorkerRuntimeRecordMatchesLiveGateway({
					expectedProcessTarget: gateway.processTarget,
					gatewayIdentity: gateway.gatewayIdentity,
					managedVm: gateway.vm,
					...(options.readProcessIdentity === undefined
						? {}
						: { readProcessIdentity: options.readProcessIdentity }),
					record: runtimeRecord,
				});
			}
			const destructionResult = await gateway.destroyGateway();
			vmDestructionComplete = true;
			if (destructionResult.kind === 'destroyed-cleanup-incomplete') {
				const [firstCleanupFailure, ...remainingCleanupFailures] =
					destructionResult.cleanupFailures;
				const firstCleanupStageError = new Error(
					`Worker VM '${gateway.vm.id}' exact destruction completed but gateway cleanup stage '${firstCleanupFailure.stage}' did not complete.`,
					{ cause: firstCleanupFailure.error },
				);
				if (remainingCleanupFailures.length === 0) {
					cleanupErrors.push(firstCleanupStageError);
				} else {
					const cleanupStageErrors = [
						firstCleanupStageError,
						...remainingCleanupFailures.map(
							(cleanupFailure) =>
								new Error(
									`Worker VM '${gateway.vm.id}' exact destruction completed but gateway cleanup stage '${cleanupFailure.stage}' did not complete.`,
									{ cause: cleanupFailure.error },
								),
						),
					];
					const cleanupAggregate = new AggregateError(
						cleanupStageErrors,
						`Worker VM '${gateway.vm.id}' exact destruction completed with incomplete gateway cleanup.`,
					);
					cleanupAggregate.cause = firstCleanupStageError;
					cleanupErrors.push(cleanupAggregate);
				}
			}
		} catch (error) {
			cleanupErrors.push(
				new Error(`Worker VM '${gateway.vm.id}' cleanup did not prove exact destruction`, {
					cause: error,
				}),
			);
		}
	}
	if (vmDestructionComplete) {
		try {
			await postStopGateway(
				prepared.taskId,
				prepared.zone,
				prepared.preStartResult.startedResourceProviders,
				{
					zoneRuntimeDir: prepared.zone.gateway.zoneRuntimeDir,
				},
			);
		} catch (error) {
			cleanupErrors.push(toError(error));
		}
		try {
			await options.onTaskFinished?.(prepared.zoneId, prepared.taskId);
		} catch (error) {
			cleanupErrors.push(toError(error));
		}
	}

	if (primaryError) {
		if (cleanupErrors.length > 0) {
			const aggregateError = new AggregateError(
				[primaryError, ...cleanupErrors],
				`Worker task ${prepared.taskId} failed; cleanup also failed.`,
			);
			aggregateError.cause = primaryError;
			throw aggregateError;
		}
		throw primaryError;
	}
	if (cleanupErrors.length === 1) {
		throw cleanupErrors[0];
	}
	if (cleanupErrors.length > 1) {
		const aggregateError = new AggregateError(
			cleanupErrors,
			`Failed to clean up worker task ${prepared.taskId}.`,
		);
		aggregateError.cause = cleanupErrors[0];
		throw aggregateError;
	}
	if (!result) {
		throw new Error(`Worker task ${prepared.taskId} exited without a terminal result.`);
	}
	return result;
}
