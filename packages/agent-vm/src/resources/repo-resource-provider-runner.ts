import fs from 'node:fs/promises';
import path from 'node:path';

import { execa } from 'execa';
import { z } from 'zod';

import type {
	ResolvedRepoResourcesFinal,
	ResourceBinding,
} from '../config/resource-contracts/index.js';
import { finalizeRepoResourceSetupInSubprocess } from './repo-resource-contract-loader.js';
import type { RepoResourceFinalization } from './resource-compiler.js';
import type { SelectedRepoResourceProvider } from './resource-resolver.js';

interface RepoSubprocessResult {
	readonly stdout: string;
}

const DOCKER_COMPOSE_TIMEOUT_MS = 120_000;
const DOCKER_INSPECT_TIMEOUT_MS = 30_000;
const REPO_SETUP_TIMEOUT_MS = 120_000;
const SAFE_REPO_SUBPROCESS_ENV_KEYS = [
	'DOCKER_CONFIG',
	'DOCKER_CONTEXT',
	'DOCKER_HOST',
	'PATH',
	'XDG_RUNTIME_DIR',
] as const;

const dockerInspectContainerSchema = z.object({
	Config: z
		.object({
			ExposedPorts: z.record(z.string(), z.unknown()).optional(),
			Labels: z.record(z.string(), z.string()).optional(),
		})
		.optional(),
	NetworkSettings: z
		.object({
			Networks: z
				.record(
					z.string(),
					z.object({
						IPAddress: z.string().optional(),
					}),
				)
				.optional(),
		})
		.optional(),
});

const dockerInspectResultSchema = z.array(dockerInspectContainerSchema);

const dockerComposeConfigSchema = z
	.object({
		services: z
			.record(
				z.string(),
				z
					.object({
						ports: z.array(z.unknown()).optional(),
					})
					.passthrough(),
			)
			.optional(),
	})
	.passthrough();

export interface RepoResourceSetupInput {
	readonly outputDir: string;
	readonly repoDir: string;
	readonly repoId: string;
	readonly repoUrl: string;
	readonly setupCommand: string;
}

export interface RepoResourceProviderStartInput extends SelectedRepoResourceProvider {
	readonly binding: ResourceBinding;
	readonly outputDir: string;
	readonly repoDir: string;
}

export interface StartedRepoResourceProvider {
	readonly composeFilePath: string;
	readonly composeProjectName: string;
	readonly repoDir: string;
	readonly repoId: string;
}

export interface StartRepoResourceProvidersResult {
	readonly finalizations: readonly RepoResourceFinalization[];
	readonly startedProviders: readonly StartedRepoResourceProvider[];
}

interface RepoResourceProviderGroup {
	readonly composeFilePath: string;
	readonly composeProjectName: string;
	readonly outputDir: string;
	readonly providers: readonly RepoResourceProviderStartInput[];
	readonly repoDir: string;
	readonly repoId: string;
	readonly repoUrl: string;
	readonly setupCommand: string;
}

function buildRepoSubprocessEnv(
	extraEnv: Readonly<Record<string, string>> = {},
): Record<string, string> {
	// Repo setup scripts are task-controlled code. Keep Docker/PATH plumbing
	// but do not inherit controller secrets or unrelated host environment.
	const environment: Record<string, string> = {};
	for (const key of SAFE_REPO_SUBPROCESS_ENV_KEYS) {
		const value = process.env[key];
		if (value) {
			environment[key] = value;
		}
	}
	return { ...environment, ...extraEnv };
}

async function runDockerCommand(options: {
	readonly args: readonly string[];
	readonly cwd: string;
	readonly timeoutMs: number;
}): Promise<RepoSubprocessResult> {
	const result = await execa('docker', options.args, {
		cwd: options.cwd,
		env: buildRepoSubprocessEnv(),
		extendEnv: false,
		reject: true,
		timeout: options.timeoutMs,
	});
	if (typeof result.stdout !== 'string') {
		throw new Error(`Docker command '${options.args.join(' ')}' returned non-string stdout.`);
	}
	return { stdout: result.stdout };
}

async function runRepoSetupCommand(options: {
	readonly args: readonly string[];
	readonly composeProjectName: string;
	readonly command: string;
	readonly cwd: string;
	readonly outputDir: string;
}): Promise<RepoSubprocessResult> {
	const result = await execa(options.command, options.args, {
		cwd: options.cwd,
		env: buildRepoSubprocessEnv({
			COMPOSE_PROJECT_NAME: options.composeProjectName,
			RESOURCE_OUTPUT_DIR: options.outputDir,
		}),
		extendEnv: false,
		reject: true,
		timeout: REPO_SETUP_TIMEOUT_MS,
	});
	if (typeof result.stdout !== 'string') {
		throw new Error(`Repo setup command '${options.command}' returned non-string stdout.`);
	}
	return { stdout: result.stdout };
}

function getSingleContainerIp(options: {
	readonly container: z.infer<typeof dockerInspectContainerSchema>;
	readonly composeProjectName: string;
	readonly service: string;
}): string | null {
	const networkIps = Object.values(options.container.NetworkSettings?.Networks ?? {})
		.map((network) => network?.IPAddress)
		.filter((ipAddress): ipAddress is string => Boolean(ipAddress));
	if (networkIps.length === 0) {
		return null;
	}
	if (networkIps.length !== 1) {
		throw new Error(
			`Compose service '${options.service}' in project '${options.composeProjectName}' must be attached to exactly one Docker network with an IP; found ${String(networkIps.length)}.`,
		);
	}
	return networkIps[0] ?? null;
}

function buildComposeProjectName(taskId: string, repoId: string): string {
	// Architecture note: this currently uses the worker task id only as a
	// temporary per-run namespace. Resource task segregation is not a complete
	// first-class model yet; when resources get their own lifecycle, replace
	// this with an explicit resource namespace/id instead of overloading taskId.
	return `agent-vm-${taskId}-${repoId}`;
}

function buildCleanupAggregateError(options: {
	readonly cause: unknown;
	readonly errors: readonly unknown[];
	readonly message: string;
}): AggregateError {
	const aggregateError = new AggregateError(options.errors, options.message);
	aggregateError.cause = options.cause;
	return aggregateError;
}

function groupReposByComposeProject(options: {
	readonly providers: readonly RepoResourceProviderStartInput[];
	readonly repos: readonly RepoResourceSetupInput[];
	readonly taskId: string;
}): RepoResourceProviderGroup[] {
	const groupsByRepoId = new Map<
		string,
		{
			composeFilePath: string;
			composeProjectName: string;
			outputDir: string;
			providers: RepoResourceProviderStartInput[];
			repoDir: string;
			repoId: string;
			repoUrl: string;
			setupCommand: string;
		}
	>();
	for (const repo of options.repos) {
		const existingGroup = groupsByRepoId.get(repo.repoId);
		if (existingGroup) {
			if (
				existingGroup.repoDir !== repo.repoDir ||
				existingGroup.outputDir !== repo.outputDir ||
				existingGroup.repoUrl !== repo.repoUrl ||
				existingGroup.setupCommand !== repo.setupCommand
			) {
				throw new Error(`Resource setup repo '${repo.repoId}' has inconsistent paths.`);
			}
			continue;
		}
		groupsByRepoId.set(repo.repoId, {
			composeFilePath: path.join(repo.repoDir, '.agent-vm', 'docker-compose.yml'),
			composeProjectName: buildComposeProjectName(options.taskId, repo.repoId),
			outputDir: repo.outputDir,
			providers: [],
			repoDir: repo.repoDir,
			repoId: repo.repoId,
			repoUrl: repo.repoUrl,
			setupCommand: repo.setupCommand,
		});
	}
	for (const provider of options.providers) {
		const existingGroup = groupsByRepoId.get(provider.repoId);
		if (!existingGroup) {
			throw new Error(`Resource provider references unknown setup repo '${provider.repoId}'.`);
		}
		if (
			existingGroup.repoDir !== provider.repoDir ||
			existingGroup.outputDir !== provider.outputDir ||
			existingGroup.repoUrl !== provider.repoUrl ||
			existingGroup.setupCommand !== provider.setupCommand
		) {
			throw new Error(`Resource provider repo '${provider.repoId}' has inconsistent paths.`);
		}
		existingGroup.providers.push(provider);
	}
	return [...groupsByRepoId.values()];
}

async function resolveComposeTarget(options: {
	readonly binding: ResourceBinding;
	readonly composeFilePath: string;
	readonly composeProjectName: string;
	readonly repoDir: string;
	readonly service: string;
}): Promise<ResourceBinding> {
	const psResult = await runDockerCommand({
		args: [
			'compose',
			'-p',
			options.composeProjectName,
			'-f',
			options.composeFilePath,
			'ps',
			'-q',
			options.service,
		],
		cwd: options.repoDir,
		timeoutMs: DOCKER_COMPOSE_TIMEOUT_MS,
	});
	const containerIds = psResult.stdout
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const inspectedContainers = await Promise.all(
		containerIds.map(async (containerId) => {
			const inspectResult = await runDockerCommand({
				args: ['inspect', containerId],
				cwd: options.repoDir,
				timeoutMs: DOCKER_INSPECT_TIMEOUT_MS,
			});
			return dockerInspectResultSchema.parse(JSON.parse(inspectResult.stdout));
		}),
	);
	for (const containers of inspectedContainers) {
		for (const container of containers) {
			const serviceName = container.Config?.Labels?.['com.docker.compose.service'];
			const host = getSingleContainerIp({
				container,
				composeProjectName: options.composeProjectName,
				service: options.service,
			});
			const exposedPorts = Object.keys(container.Config?.ExposedPorts ?? {});
			const exposesBindingPort = exposedPorts.includes(`${options.binding.port}/tcp`);
			if (serviceName === options.service && host && exposesBindingPort) {
				return { host, port: options.binding.port };
			}
		}
	}
	throw new Error(
		`Unable to resolve compose target for service '${options.service}' in project '${options.composeProjectName}' exposing ${String(options.binding.port)}/tcp.`,
	);
}

async function assertSelectedServicesDoNotPublishHostPorts(options: {
	readonly composeFilePath: string;
	readonly composeProjectName: string;
	readonly repoDir: string;
	readonly services: readonly string[];
}): Promise<void> {
	const configResult = await runDockerCommand({
		args: [
			'compose',
			'-p',
			options.composeProjectName,
			'-f',
			options.composeFilePath,
			'config',
			'--format',
			'json',
		],
		cwd: options.repoDir,
		timeoutMs: DOCKER_COMPOSE_TIMEOUT_MS,
	});
	const config = dockerComposeConfigSchema.parse(JSON.parse(configResult.stdout));
	for (const serviceName of options.services) {
		const service = config.services?.[serviceName];
		if ((service?.ports?.length ?? 0) > 0) {
			throw new Error(
				`Repo resource compose service '${serviceName}' must not publish host ports; use expose/internal service ports so parallel tasks and repos do not collide.`,
			);
		}
	}
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
	const relativePath = path.relative(parentPath, candidatePath);
	return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

async function validateGeneratedResourcePaths(options: {
	readonly final: ResolvedRepoResourcesFinal;
	readonly outputDir: string;
	readonly repoId: string;
}): Promise<void> {
	const realOutputDir = await fs.realpath(options.outputDir);
	await Promise.all(
		options.final.generated.map(async (generatedPath) => {
			const absolutePath = path.resolve(options.outputDir, generatedPath.path);
			if (!isPathInside(options.outputDir, absolutePath)) {
				throw new Error(
					`Generated resource path '${generatedPath.path}' for repo '${options.repoId}' escapes RESOURCE_OUTPUT_DIR.`,
				);
			}
			const realGeneratedPath = await fs.realpath(absolutePath);
			if (!isPathInside(realOutputDir, realGeneratedPath)) {
				throw new Error(
					`Generated resource path '${generatedPath.path}' for repo '${options.repoId}' escapes RESOURCE_OUTPUT_DIR.`,
				);
			}
			const stat = await fs.stat(realGeneratedPath);
			if (generatedPath.kind === 'directory' && !stat.isDirectory()) {
				throw new Error(
					`Generated resource path '${generatedPath.path}' for repo '${options.repoId}' is not a directory.`,
				);
			}
			if (generatedPath.kind === 'file' && !stat.isFile()) {
				throw new Error(
					`Generated resource path '${generatedPath.path}' for repo '${options.repoId}' is not a file.`,
				);
			}
		}),
	);
}

async function startOneProviderGroup(options: {
	readonly group: RepoResourceProviderGroup;
}): Promise<{
	readonly finalization: RepoResourceFinalization;
	readonly startedProvider: StartedRepoResourceProvider | undefined;
}> {
	const startedProvider = {
		composeFilePath: options.group.composeFilePath,
		composeProjectName: options.group.composeProjectName,
		repoDir: options.group.repoDir,
		repoId: options.group.repoId,
	};
	let composeStarted = false;
	try {
		await fs.mkdir(options.group.outputDir, { recursive: true });
		const services = [
			...new Set(options.group.providers.map((provider) => provider.provider.service)),
		];
		if (services.length > 0) {
			await assertSelectedServicesDoNotPublishHostPorts({
				composeFilePath: options.group.composeFilePath,
				composeProjectName: options.group.composeProjectName,
				repoDir: options.group.repoDir,
				services,
			});
			composeStarted = true;
			await runDockerCommand({
				args: [
					'compose',
					'-p',
					options.group.composeProjectName,
					'-f',
					options.group.composeFilePath,
					'up',
					'-d',
					'--wait',
					'--no-deps',
					...services,
				],
				cwd: options.group.repoDir,
				timeoutMs: DOCKER_COMPOSE_TIMEOUT_MS,
			});
		}
		const selectedResources = Object.fromEntries(
			await Promise.all(
				options.group.providers.map(async (provider) => {
					const target = await resolveComposeTarget({
						binding: provider.binding,
						composeFilePath: options.group.composeFilePath,
						composeProjectName: options.group.composeProjectName,
						repoDir: options.group.repoDir,
						service: provider.provider.service,
					});
					return [provider.resourceName, { binding: provider.binding, target }] as const;
				}),
			),
		);
		const setupCommand = path.resolve(options.group.repoDir, options.group.setupCommand);
		const relativeSetupCommand = path.relative(options.group.repoDir, setupCommand);
		if (relativeSetupCommand.startsWith('..') || path.isAbsolute(relativeSetupCommand)) {
			throw new Error(`setupCommand for repo '${options.group.repoId}' must stay inside the repo.`);
		}
		await runRepoSetupCommand({
			args: [],
			composeProjectName: options.group.composeProjectName,
			command: setupCommand,
			cwd: options.group.repoDir,
			outputDir: options.group.outputDir,
		});
		const final = await finalizeRepoResourceSetupInSubprocess({
			repoDir: options.group.repoDir,
			input: {
				repoId: options.group.repoId,
				repoUrl: options.group.repoUrl,
				repoDir: options.group.repoDir,
				outputDir: options.group.outputDir,
				selectedResources,
			},
		});
		await validateGeneratedResourcePaths({
			final,
			outputDir: options.group.outputDir,
			repoId: options.group.repoId,
		});
		return {
			finalization: {
				final,
				outputDir: options.group.outputDir,
				repoId: options.group.repoId,
			},
			startedProvider: composeStarted ? startedProvider : undefined,
		};
	} catch (error) {
		if (!composeStarted) {
			throw error;
		}
		try {
			await stopRepoResourceProviders([startedProvider]);
		} catch (cleanupError) {
			throw buildCleanupAggregateError({
				cause: error,
				errors: [error, cleanupError],
				message: `Failed to start and clean up repo resource provider '${options.group.repoId}'.`,
			});
		}
		throw error;
	}
}

export async function startRepoResourceProviders(options: {
	readonly providers: readonly RepoResourceProviderStartInput[];
	readonly repos: readonly RepoResourceSetupInput[];
	readonly taskId: string;
}): Promise<StartRepoResourceProvidersResult> {
	const groups = groupReposByComposeProject(options);
	const settledResults = await Promise.allSettled(
		groups.map(async (group) => await startOneProviderGroup({ group })),
	);
	const rejectedReasons: unknown[] = [];
	for (const result of settledResults) {
		if (result.status === 'rejected') {
			rejectedReasons.push(result.reason);
		}
	}
	if (rejectedReasons.length > 0) {
		const startedProviders = settledResults.flatMap((result) =>
			result.status === 'fulfilled' && result.value.startedProvider
				? [result.value.startedProvider]
				: [],
		);
		try {
			await stopRepoResourceProviders(startedProviders);
		} catch (cleanupError) {
			throw buildCleanupAggregateError({
				cause: rejectedReasons[0],
				errors: [...rejectedReasons, cleanupError],
				message: 'Failed to start repo resource providers and clean up started providers.',
			});
		}
		if (rejectedReasons.length === 1) {
			throw rejectedReasons[0];
		}
		throw new AggregateError(rejectedReasons, 'Failed to start repo resource providers.');
	}
	const results = settledResults.map((result) => {
		if (result.status === 'rejected') {
			throw result.reason;
		}
		return result.value;
	});
	return {
		finalizations: results.map((result) => result.finalization),
		startedProviders: results.flatMap((result) =>
			result.startedProvider ? [result.startedProvider] : [],
		),
	};
}

export async function stopRepoResourceProviders(
	providers: readonly StartedRepoResourceProvider[],
): Promise<void> {
	const uniqueProviders = [
		...new Map(
			providers.map((provider) => [
				`${provider.composeProjectName}\0${provider.composeFilePath}\0${provider.repoDir}`,
				provider,
			]),
		).values(),
	];
	const errors: unknown[] = [];
	await Promise.all(
		uniqueProviders.map(async (provider) => {
			try {
				await runDockerCommand({
					args: [
						'compose',
						'-p',
						provider.composeProjectName,
						'-f',
						provider.composeFilePath,
						'down',
						'--remove-orphans',
					],
					cwd: provider.repoDir,
					timeoutMs: DOCKER_COMPOSE_TIMEOUT_MS,
				});
			} catch (error) {
				errors.push(error);
			}
		}),
	);
	if (errors.length === 1) {
		throw new Error('Failed to stop repo resource provider.', { cause: errors[0] });
	}
	if (errors.length > 1) {
		throw new AggregateError(errors, 'Failed to stop one or more repo resource providers.');
	}
}
