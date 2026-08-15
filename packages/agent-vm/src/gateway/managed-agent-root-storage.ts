import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { agentIdSchema } from '../config/system-config-identifier-schemas.js';

export interface ManagedAgentWorkspacePaths {
	readonly agentId: string;
	readonly gatewayWorkspaceRoot: string;
	readonly hostWorkspaceRoot: string;
}

export function resolveManagedAgentGitDirectoryRoot(options: {
	readonly agentId: string;
	readonly zoneRuntimeDir: string;
}): string {
	if (!path.isAbsolute(options.zoneRuntimeDir)) {
		throw new Error('Managed agent Git directory zoneRuntimeDir must be absolute.');
	}
	const agentId = agentIdSchema.parse(options.agentId);
	return path.join(options.zoneRuntimeDir, 'gitdirs', 'agents', agentId);
}

export async function materializeManagedAgentGitDirectoryRoot(options: {
	readonly agentId: string;
	readonly zoneRuntimeDir: string;
}): Promise<string> {
	const hostGitDirectoryRoot = resolveManagedAgentGitDirectoryRoot(options);
	const gitDirectoriesRoot = path.join(options.zoneRuntimeDir, 'gitdirs');
	const agentGitDirectoriesRoot = path.join(gitDirectoriesRoot, 'agents');
	await assertExistingRealDirectory(options.zoneRuntimeDir);
	for (const directoryPath of [gitDirectoriesRoot, agentGitDirectoriesRoot, hostGitDirectoryRoot]) {
		// oxlint-disable-next-line no-await-in-loop -- each real directory is admitted in parent-to-child order.
		await ensureRealDirectory(directoryPath);
	}

	const canonicalZoneRuntimeDir = await realpath(options.zoneRuntimeDir);
	const canonicalGitDirectoryRoot = await realpath(hostGitDirectoryRoot);
	const expectedCanonicalGitDirectoryRoot = path.join(
		canonicalZoneRuntimeDir,
		'gitdirs',
		'agents',
		agentIdSchema.parse(options.agentId),
	);
	if (canonicalGitDirectoryRoot !== expectedCanonicalGitDirectoryRoot) {
		throw new Error(
			`Managed agent Git directory root '${canonicalGitDirectoryRoot}' does not match controller-derived path '${expectedCanonicalGitDirectoryRoot}'.`,
		);
	}
	return canonicalGitDirectoryRoot;
}

async function assertExistingRealDirectory(directoryPath: string): Promise<void> {
	const status = await lstat(directoryPath);
	if (!status.isDirectory() || status.isSymbolicLink()) {
		throw new Error(`Managed agent storage path '${directoryPath}' must be a real directory.`);
	}
}

function isSameOrDescendantPath(candidatePath: string, rootPath: string): boolean {
	const relativePath = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
	return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function assertPathsDisjoint(options: {
	readonly firstLabel: string;
	readonly firstPath: string;
	readonly secondLabel: string;
	readonly secondPath: string;
}): void {
	if (
		isSameOrDescendantPath(options.firstPath, options.secondPath) ||
		isSameOrDescendantPath(options.secondPath, options.firstPath)
	) {
		throw new Error(
			`${options.firstLabel} '${options.firstPath}' must remain disjoint from ${options.secondLabel} '${options.secondPath}'.`,
		);
	}
}

async function resolveCanonicalPathFromExistingAncestor(inputPath: string): Promise<string> {
	let existingCandidatePath = path.resolve(inputPath);
	const missingSegments: string[] = [];
	while (true) {
		try {
			// oxlint-disable-next-line no-await-in-loop -- each iteration probes the next existing ancestor in order.
			return path.join(await realpath(existingCandidatePath), ...missingSegments);
		} catch (error) {
			if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
				throw error;
			}
			const parentPath = path.dirname(existingCandidatePath);
			if (parentPath === existingCandidatePath) {
				throw new Error(`Managed agent storage path '${inputPath}' has no existing ancestor.`, {
					cause: error,
				});
			}
			missingSegments.unshift(path.basename(existingCandidatePath));
			existingCandidatePath = parentPath;
		}
	}
}

async function assertCanonicalStorageBoundaries(options: {
	readonly controllerStateDir: string;
	readonly stateDir: string;
	readonly zoneFilesDir: string;
}): Promise<void> {
	const [controllerStateDir, stateDir, zoneFilesDir] = await Promise.all([
		resolveCanonicalPathFromExistingAncestor(options.controllerStateDir),
		resolveCanonicalPathFromExistingAncestor(options.stateDir),
		resolveCanonicalPathFromExistingAncestor(options.zoneFilesDir),
	]);
	assertPathsDisjoint({
		firstLabel: 'controllerStateDir',
		firstPath: controllerStateDir,
		secondLabel: 'zoneFilesDir',
		secondPath: zoneFilesDir,
	});
	assertPathsDisjoint({
		firstLabel: 'controllerStateDir',
		firstPath: controllerStateDir,
		secondLabel: 'stateDir',
		secondPath: stateDir,
	});
	assertPathsDisjoint({
		firstLabel: 'stateDir',
		firstPath: stateDir,
		secondLabel: 'zoneFilesDir',
		secondPath: zoneFilesDir,
	});
}

async function ensureRealDirectory(directoryPath: string): Promise<void> {
	try {
		await mkdir(directoryPath, { mode: 0o700 });
	} catch (error) {
		if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) {
			throw error;
		}
	}
	const status = await lstat(directoryPath);
	if (!status.isDirectory() || status.isSymbolicLink()) {
		throw new Error(`Managed agent storage path '${directoryPath}' must be a real directory.`);
	}
	await chmod(directoryPath, 0o700);
}

export function resolveManagedAgentRootPaths(options: {
	readonly agentId: string;
	readonly zoneFilesDir: string;
}): ManagedAgentWorkspacePaths {
	const agentId = agentIdSchema.parse(options.agentId);
	const hostWorkspaceRoot = path.join(options.zoneFilesDir, 'agents', agentId);
	return {
		agentId,
		gatewayWorkspaceRoot: `/zone/agents/${agentId}`,
		hostWorkspaceRoot,
	};
}

export async function materializeManagedAgentRootStorage(options: {
	readonly agentIds: readonly string[];
	readonly controllerStateDir: string;
	readonly stateDir: string;
	readonly zoneFilesDir: string;
}): Promise<readonly ManagedAgentWorkspacePaths[]> {
	await assertCanonicalStorageBoundaries(options);

	const validatedAgentIds = options.agentIds.map((agentId) => agentIdSchema.parse(agentId));
	if (new Set(validatedAgentIds).size !== validatedAgentIds.length) {
		throw new Error('Managed agent root materialization rejected a duplicate agent id.');
	}

	await ensureRealDirectory(options.zoneFilesDir);
	const agentsRoot = path.join(options.zoneFilesDir, 'agents');
	await ensureRealDirectory(agentsRoot);

	const materializedRoots = await Promise.all(
		validatedAgentIds.toSorted().map(async (agentId): Promise<ManagedAgentWorkspacePaths> => {
			const unresolvedPaths = resolveManagedAgentRootPaths({
				agentId,
				zoneFilesDir: options.zoneFilesDir,
			});
			await ensureRealDirectory(unresolvedPaths.hostWorkspaceRoot);
			const hostWorkspaceRoot = await realpath(unresolvedPaths.hostWorkspaceRoot);
			return {
				agentId: unresolvedPaths.agentId,
				gatewayWorkspaceRoot: unresolvedPaths.gatewayWorkspaceRoot,
				hostWorkspaceRoot,
			};
		}),
	);
	return Object.freeze(materializedRoots.map((rootPaths) => Object.freeze(rootPaths)));
}
