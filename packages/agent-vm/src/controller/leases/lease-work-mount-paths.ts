import { realpath } from 'node:fs/promises';
import path from 'node:path';

import type { SystemConfig } from '../../config/system-config.js';

// These guest roots are mounted by the OpenClaw gateway image. Lease callers
// must speak in gateway paths; the controller owns translation to host paths.
const OPENCLAW_STATE_VM_ROOT = '/home/openclaw/.openclaw/state';
const OPENCLAW_STATE_SANDBOXES_VM_ROOT = `${OPENCLAW_STATE_VM_ROOT}/sandboxes`;
const OPENCLAW_ZONE_FILES_VM_ROOT = '/zone';

type ZoneConfig = SystemConfig['zones'][number];

export class LeaseWorkMountValidationError extends Error {}

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
	readonly workMountDir: string;
}): string | null {
	const normalizedWorkMountDir = path.posix.normalize(options.workMountDir);
	if (
		normalizedWorkMountDir !== options.guestRoot &&
		!normalizedWorkMountDir.startsWith(`${options.guestRoot}/`)
	) {
		return null;
	}
	const relativePath = path.posix.relative(options.guestRoot, normalizedWorkMountDir);
	return path.join(options.hostRoot, relativePath);
}

async function realpathIfDirectory(directoryPath: string): Promise<string> {
	try {
		return await realpath(directoryPath);
	} catch (error) {
		const code =
			error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN';
		const message = error instanceof Error ? error.message : String(error);
		throw new LeaseWorkMountValidationError(
			`Lease work mount path '${directoryPath}' failed directory realpath check (${code}): ${message}`,
			{ cause: error },
		);
	}
}

async function realpathAllowedRoot(directoryPath: string): Promise<string | null> {
	try {
		return await realpath(directoryPath);
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
			return null;
		}
		throw error;
	}
}

async function validateResolvedLeaseWorkMountDir(options: {
	readonly hostWorkMountDir: string;
	readonly zone: ZoneConfig;
}): Promise<string> {
	if (options.zone.gateway.type !== 'openclaw') {
		throw new LeaseWorkMountValidationError(
			`Zone '${options.zone.id}' does not support OpenClaw tool VM leases.`,
		);
	}
	const hostSandboxRoot = path.join(options.zone.gateway.stateDir, 'sandboxes');
	const [realCandidatePath, realSandboxRoot, realZoneFilesRoot] = await Promise.all([
		realpathIfDirectory(options.hostWorkMountDir),
		realpathAllowedRoot(hostSandboxRoot),
		realpathAllowedRoot(options.zone.gateway.zoneFilesDir),
	]);
	const allowedRoots = [realSandboxRoot, realZoneFilesRoot].filter(
		(root): root is string => root !== null,
	);
	if (!allowedRoots.some((root) => isPathWithin(realCandidatePath, root))) {
		throw new LeaseWorkMountValidationError(
			`Lease hostWorkMountDir '${options.hostWorkMountDir}' resolves outside allowed OpenClaw tool work mount roots for zone '${options.zone.id}'.`,
		);
	}
	return realCandidatePath;
}

export async function validateResolvedToolWorkMountDir(options: {
	readonly hostWorkMountDir: string;
	readonly zone: ZoneConfig;
}): Promise<string> {
	if (options.zone.gateway.type !== 'openclaw') {
		throw new LeaseWorkMountValidationError(
			`Zone '${options.zone.id}' does not support OpenClaw tool VM leases.`,
		);
	}
	if (!path.isAbsolute(options.hostWorkMountDir)) {
		throw new LeaseWorkMountValidationError(
			`Lease hostWorkMountDir '${options.hostWorkMountDir}' must be absolute.`,
		);
	}
	if (pathContainsParentTraversal(options.hostWorkMountDir)) {
		throw new LeaseWorkMountValidationError(
			`Lease hostWorkMountDir '${options.hostWorkMountDir}' must not contain '..' path segments.`,
		);
	}
	return await validateResolvedLeaseWorkMountDir(options);
}

export async function resolveLeaseWorkMountDir(options: {
	readonly workMountDir: string;
	readonly zone: ZoneConfig;
}): Promise<string> {
	if (options.zone.gateway.type !== 'openclaw') {
		throw new LeaseWorkMountValidationError(
			`Zone '${options.zone.id}' does not support OpenClaw tool VM leases.`,
		);
	}
	if (!path.isAbsolute(options.workMountDir)) {
		throw new LeaseWorkMountValidationError(
			`Lease workMountDir '${options.workMountDir}' must be absolute.`,
		);
	}
	if (pathContainsParentTraversal(options.workMountDir)) {
		throw new LeaseWorkMountValidationError(
			`Lease workMountDir '${options.workMountDir}' must not contain '..' path segments.`,
		);
	}

	const hostSandboxRoot = path.join(options.zone.gateway.stateDir, 'sandboxes');
	const hostWorkMountDir =
		mapGuestPathToHostPath({
			guestRoot: OPENCLAW_STATE_SANDBOXES_VM_ROOT,
			hostRoot: hostSandboxRoot,
			workMountDir: options.workMountDir,
		}) ??
		mapGuestPathToHostPath({
			guestRoot: OPENCLAW_ZONE_FILES_VM_ROOT,
			hostRoot: options.zone.gateway.zoneFilesDir,
			workMountDir: options.workMountDir,
		});
	if (!hostWorkMountDir) {
		throw new LeaseWorkMountValidationError(
			`Lease workMountDir '${options.workMountDir}' must be under ${OPENCLAW_STATE_SANDBOXES_VM_ROOT} or ${OPENCLAW_ZONE_FILES_VM_ROOT}.`,
		);
	}
	return await validateResolvedLeaseWorkMountDir({
		hostWorkMountDir,
		zone: options.zone,
	});
}
