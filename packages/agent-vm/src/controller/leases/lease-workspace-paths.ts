import fs from 'node:fs/promises';
import path from 'node:path';

import type { SystemConfig } from '../../config/system-config.js';

const OPENCLAW_STATE_VM_ROOT = '/home/openclaw/.openclaw/state';
const OPENCLAW_STATE_SANDBOXES_VM_ROOT = `${OPENCLAW_STATE_VM_ROOT}/sandboxes`;
const OPENCLAW_ZONE_FILES_VM_ROOT = '/home/openclaw/zone-files';

type ZoneConfig = SystemConfig['zones'][number];

export class LeaseWorkspaceValidationError extends Error {}

function pathContainsParentTraversal(inputPath: string): boolean {
	return inputPath.split(/[\\/]+/u).includes('..');
}

function isPathWithin(candidatePath: string, rootPath: string): boolean {
	const relativePath = path.relative(rootPath, candidatePath);
	return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function mapGuestPathToHostPath(options: {
	readonly guestRoot: string;
	readonly hostRoot: string;
	readonly workspaceDir: string;
}): string | null {
	const normalizedWorkspaceDir = path.posix.normalize(options.workspaceDir);
	if (
		normalizedWorkspaceDir !== options.guestRoot &&
		!normalizedWorkspaceDir.startsWith(`${options.guestRoot}/`)
	) {
		return null;
	}
	const relativePath = path.posix.relative(options.guestRoot, normalizedWorkspaceDir);
	return path.join(options.hostRoot, relativePath);
}

async function realpathIfDirectory(directoryPath: string): Promise<string> {
	try {
		return await fs.realpath(directoryPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new LeaseWorkspaceValidationError(
			`Lease workspace path '${directoryPath}' is not an existing directory: ${message}`,
			{ cause: error },
		);
	}
}

async function realpathAllowedRoot(directoryPath: string): Promise<string | null> {
	try {
		return await fs.realpath(directoryPath);
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
			return null;
		}
		throw error;
	}
}

export async function resolveLeaseWorkspaceDir(options: {
	readonly workspaceDir: string;
	readonly zone: ZoneConfig;
}): Promise<string> {
	if (options.zone.gateway.type !== 'openclaw') {
		throw new LeaseWorkspaceValidationError(
			`Zone '${options.zone.id}' does not support OpenClaw tool VM leases.`,
		);
	}
	if (!path.isAbsolute(options.workspaceDir)) {
		throw new LeaseWorkspaceValidationError(
			`Lease workspaceDir '${options.workspaceDir}' must be absolute.`,
		);
	}
	if (pathContainsParentTraversal(options.workspaceDir)) {
		throw new LeaseWorkspaceValidationError(
			`Lease workspaceDir '${options.workspaceDir}' must not contain '..' path segments.`,
		);
	}

	const hostSandboxRoot = path.join(options.zone.gateway.stateDir, 'sandboxes');
	const candidatePath =
		mapGuestPathToHostPath({
			guestRoot: OPENCLAW_STATE_SANDBOXES_VM_ROOT,
			hostRoot: hostSandboxRoot,
			workspaceDir: options.workspaceDir,
		}) ??
		mapGuestPathToHostPath({
			guestRoot: OPENCLAW_ZONE_FILES_VM_ROOT,
			hostRoot: options.zone.gateway.zoneFilesDir,
			workspaceDir: options.workspaceDir,
		}) ??
		path.resolve(options.workspaceDir);

	const [realCandidatePath, realSandboxRoot, realZoneFilesRoot] = await Promise.all([
		realpathIfDirectory(candidatePath),
		realpathAllowedRoot(hostSandboxRoot),
		realpathAllowedRoot(options.zone.gateway.zoneFilesDir),
	]);
	const allowedRoots = [realSandboxRoot, realZoneFilesRoot].filter(
		(root): root is string => root !== null,
	);
	if (!allowedRoots.some((root) => isPathWithin(realCandidatePath, root))) {
		throw new LeaseWorkspaceValidationError(
			`Lease workspaceDir '${options.workspaceDir}' resolves outside allowed OpenClaw tool workspace roots for zone '${options.zone.id}'.`,
		);
	}
	return realCandidatePath;
}
