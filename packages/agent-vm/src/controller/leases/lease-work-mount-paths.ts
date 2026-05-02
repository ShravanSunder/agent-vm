import { realpath } from 'node:fs/promises';
import path from 'node:path';

import type { SystemConfig } from '../../config/system-config.js';

// These guest roots are mounted by the OpenClaw gateway image. Lease callers
// must speak in gateway paths; the controller owns translation to host paths.
const OPENCLAW_STATE_VM_ROOT = '/home/openclaw/.openclaw/state';
const OPENCLAW_STATE_SANDBOXES_VM_ROOT = `${OPENCLAW_STATE_VM_ROOT}/sandboxes`;
const OPENCLAW_ZONE_FILES_VM_ROOT = '/zone';

type ZoneConfig = SystemConfig['zones'][number];

export type LeaseWorkMountValidationErrorKind =
	| 'allowed-root-realpath-failed'
	| 'host-not-absolute'
	| 'host-outside-allowed-roots'
	| 'host-parent-traversal'
	| 'outside-allowed-roots'
	| 'realpath-failed'
	| 'root-mount-target'
	| 'unsupported-gateway'
	| 'work-mount-not-absolute'
	| 'work-mount-parent-traversal';

export class LeaseWorkMountValidationError extends Error {
	readonly kind: LeaseWorkMountValidationErrorKind;

	constructor(kind: LeaseWorkMountValidationErrorKind, message: string, options?: ErrorOptions) {
		super(message, options);
		this.kind = kind;
	}
}

function pathContainsParentTraversal(inputPath: string): boolean {
	return inputPath.split(/[\\/]+/u).includes('..');
}

function normalizeGuestWorkMountDir(workMountDir: string): string {
	const normalizedWorkMountDir = path.posix.normalize(workMountDir);
	return normalizedWorkMountDir.length > 1
		? normalizedWorkMountDir.replace(/\/+$/u, '')
		: normalizedWorkMountDir;
}

function isPathWithin(candidatePath: string, rootPath: string): boolean {
	const relativePath = path.relative(rootPath, candidatePath);
	return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function mapGuestPathToHostPath(options: {
	readonly guestRoot: string;
	readonly hostRoot: string;
	readonly normalizedWorkMountDir: string;
}): string | null {
	if (!options.normalizedWorkMountDir.startsWith(`${options.guestRoot}/`)) {
		return null;
	}
	const relativePath = path.posix.relative(options.guestRoot, options.normalizedWorkMountDir);
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
			'realpath-failed',
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
		const code =
			error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN';
		const message = error instanceof Error ? error.message : String(error);
		throw new LeaseWorkMountValidationError(
			'allowed-root-realpath-failed',
			`Lease allowed work mount root '${directoryPath}' failed directory realpath check (${code}): ${message}`,
			{ cause: error },
		);
	}
}

async function validateResolvedLeaseWorkMountDir(options: {
	readonly hostWorkMountDir: string;
	readonly zone: ZoneConfig;
}): Promise<string> {
	if (options.zone.gateway.type !== 'openclaw') {
		throw new LeaseWorkMountValidationError(
			'unsupported-gateway',
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
			'host-outside-allowed-roots',
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
			'unsupported-gateway',
			`Zone '${options.zone.id}' does not support OpenClaw tool VM leases.`,
		);
	}
	if (!path.isAbsolute(options.hostWorkMountDir)) {
		throw new LeaseWorkMountValidationError(
			'host-not-absolute',
			`Lease hostWorkMountDir '${options.hostWorkMountDir}' must be absolute.`,
		);
	}
	if (pathContainsParentTraversal(options.hostWorkMountDir)) {
		throw new LeaseWorkMountValidationError(
			'host-parent-traversal',
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
			'unsupported-gateway',
			`Zone '${options.zone.id}' does not support OpenClaw tool VM leases.`,
		);
	}
	if (!path.isAbsolute(options.workMountDir)) {
		throw new LeaseWorkMountValidationError(
			'work-mount-not-absolute',
			`Lease workMountDir '${options.workMountDir}' must be absolute.`,
		);
	}
	if (pathContainsParentTraversal(options.workMountDir)) {
		throw new LeaseWorkMountValidationError(
			'work-mount-parent-traversal',
			`Lease workMountDir '${options.workMountDir}' must not contain '..' path segments.`,
		);
	}
	const normalizedWorkMountDir = normalizeGuestWorkMountDir(options.workMountDir);
	if (
		normalizedWorkMountDir === OPENCLAW_STATE_SANDBOXES_VM_ROOT ||
		normalizedWorkMountDir === OPENCLAW_ZONE_FILES_VM_ROOT
	) {
		throw new LeaseWorkMountValidationError(
			'root-mount-target',
			`Lease workMountDir '${options.workMountDir}' must name a child path under ${OPENCLAW_ZONE_FILES_VM_ROOT} or ${OPENCLAW_STATE_SANDBOXES_VM_ROOT}, not the root itself.`,
		);
	}

	const hostSandboxRoot = path.join(options.zone.gateway.stateDir, 'sandboxes');
	const hostWorkMountDir =
		mapGuestPathToHostPath({
			guestRoot: OPENCLAW_STATE_SANDBOXES_VM_ROOT,
			hostRoot: hostSandboxRoot,
			normalizedWorkMountDir,
		}) ??
		mapGuestPathToHostPath({
			guestRoot: OPENCLAW_ZONE_FILES_VM_ROOT,
			hostRoot: options.zone.gateway.zoneFilesDir,
			normalizedWorkMountDir,
		});
	if (!hostWorkMountDir) {
		throw new LeaseWorkMountValidationError(
			'outside-allowed-roots',
			`Lease workMountDir '${options.workMountDir}' must be under ${OPENCLAW_STATE_SANDBOXES_VM_ROOT} or ${OPENCLAW_ZONE_FILES_VM_ROOT}.`,
		);
	}
	return await validateResolvedLeaseWorkMountDir({
		hostWorkMountDir,
		zone: options.zone,
	});
}
