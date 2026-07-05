import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
	TOOL_VM_WORKSPACE_GUEST_ROOT,
	translateRuntimePath,
	type RuntimePathTranslationErrorCode,
} from '@agent-vm/gateway-interface';

import type { SystemConfig } from '../../config/system-config.js';
import {
	OPENCLAW_ZONE_FILES_GUEST_ROOT,
	isOpenClawZoneGitConfigured,
	resolveZoneGitPaths,
	type ZoneGitToolVmMount,
} from '../zone-git/zone-git-paths.js';
import { pathContainsParentTraversal } from './lease-path-helpers.js';
import {
	OPENCLAW_STATE_VM_ROOT,
	OPENCLAW_STATE_SANDBOXES_VM_ROOT,
	createOpenClawGatewayLeasePathMapping,
} from './openclaw-gateway-lease-path-mapping.js';

const OPENCLAW_ZONE_FILES_VM_ROOT = OPENCLAW_ZONE_FILES_GUEST_ROOT;
export const OPENCLAW_TOOL_VM_WORKSPACE_MOUNT = TOOL_VM_WORKSPACE_GUEST_ROOT;

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
	| 'work-mount-parent-traversal'
	| 'work-mount-purpose-not-allowed'
	| 'work-mount-unknown-runtime-path';

interface LeaseWorkMountValidationErrorOptions extends ErrorOptions {
	readonly guidance?: string;
}

export class LeaseWorkMountValidationError extends Error {
	readonly guidance: string | undefined;
	readonly kind: LeaseWorkMountValidationErrorKind;

	constructor(
		kind: LeaseWorkMountValidationErrorKind,
		message: string,
		options?: LeaseWorkMountValidationErrorOptions,
	) {
		super(message, options);
		this.name = 'LeaseWorkMountValidationError';
		this.guidance = options?.guidance;
		this.kind = kind;
	}
}

export interface ResolvedLeaseWorkMount {
	readonly guestWorkdir: string;
	readonly hostWorkMountDir: string;
	readonly zoneGitMount?: ZoneGitToolVmMount;
}

const translatorErrorKindByCode = {
	'invalid-runtime-root': 'outside-allowed-roots',
	'path-not-absolute': 'work-mount-not-absolute',
	'path-parent-traversal': 'work-mount-parent-traversal',
	'purpose-not-allowed': 'work-mount-purpose-not-allowed',
	'root-path-not-allowed': 'root-mount-target',
	'target-namespace-not-available': 'work-mount-unknown-runtime-path',
	'unknown-runtime-path': 'work-mount-unknown-runtime-path',
} satisfies Record<RuntimePathTranslationErrorCode, LeaseWorkMountValidationErrorKind>;

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

export function findOpenClawLeaseWorkMountAgentMismatch(options: {
	readonly agentId: string;
	readonly relativePath: string;
	readonly rootId: string;
	readonly workMountDir: string;
}): string | undefined {
	if (
		options.rootId === 'openclaw-sandboxes' &&
		!options.relativePath.startsWith(`${options.agentId}/`)
	) {
		return `Lease workMountDir '${options.workMountDir}' matched OpenClaw sandboxes, but only '${OPENCLAW_STATE_SANDBOXES_VM_ROOT}/${options.agentId}/...' is allowed for agent '${options.agentId}'.`;
	}
	if (
		options.rootId === 'openclaw-state' &&
		options.relativePath !== `workspace-${options.agentId}`
	) {
		return `Lease workMountDir '${options.workMountDir}' matched OpenClaw state, but only '${OPENCLAW_STATE_VM_ROOT}/workspace-${options.agentId}' is allowed for agent '${options.agentId}'.`;
	}
	if (options.rootId === 'zone-files') {
		const expectedAgentWorkspacePath = `agents/${options.agentId}`;
		if (
			options.relativePath === expectedAgentWorkspacePath ||
			options.relativePath.startsWith(`${expectedAgentWorkspacePath}/`)
		) {
			return undefined;
		}
		return `Lease workMountDir '${options.workMountDir}' matched OpenClaw zone files, but only '${OPENCLAW_ZONE_FILES_VM_ROOT}/${expectedAgentWorkspacePath}' or its children are allowed for agent '${options.agentId}'.`;
	}
	return undefined;
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

async function assertAgentOwnedRootIsRealDirectory(options: {
	readonly agentId: string;
	readonly ownedHostRoot: string;
	readonly workMountDir: string;
}): Promise<void> {
	let rootStats: Awaited<ReturnType<typeof lstat>>;
	try {
		rootStats = await lstat(options.ownedHostRoot);
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
			throw new LeaseWorkMountValidationError(
				'work-mount-purpose-not-allowed',
				`Lease workMountDir '${options.workMountDir}' does not have a host workspace owned by agent '${options.agentId}'.`,
			);
		}
		const code =
			error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN';
		const message = error instanceof Error ? error.message : String(error);
		throw new LeaseWorkMountValidationError(
			'allowed-root-realpath-failed',
			`Lease owned work mount root '${options.ownedHostRoot}' failed directory lstat check (${code}): ${message}`,
			{ cause: error },
		);
	}
	if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
		throw new LeaseWorkMountValidationError(
			'work-mount-purpose-not-allowed',
			`Lease workMountDir '${options.workMountDir}' must resolve through a real host workspace owned by agent '${options.agentId}', not a symlink or non-directory root.`,
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
	const [realCandidatePath, realSandboxRoot, realZoneFilesRoot, realStateRoot] = await Promise.all([
		realpathIfDirectory(options.hostWorkMountDir),
		realpathAllowedRoot(hostSandboxRoot),
		realpathAllowedRoot(options.zone.gateway.zoneFilesDir),
		realpathAllowedRoot(options.zone.gateway.stateDir),
	]);
	const allowedRoots = [realSandboxRoot, realZoneFilesRoot].filter(
		(root): root is string => root !== null,
	);
	const stateRelativePath =
		realStateRoot === null || !isPathWithin(realCandidatePath, realStateRoot)
			? null
			: path.relative(realStateRoot, realCandidatePath);
	const isStateWorkspacePath =
		stateRelativePath !== null &&
		(stateRelativePath === 'workspace' ||
			stateRelativePath.startsWith(`workspace${path.sep}`) ||
			stateRelativePath.startsWith('workspace-'));
	if (
		!allowedRoots.some((root) => isPathWithin(realCandidatePath, root)) &&
		!isStateWorkspacePath
	) {
		throw new LeaseWorkMountValidationError(
			'host-outside-allowed-roots',
			`Lease hostWorkMountDir '${options.hostWorkMountDir}' resolves outside allowed OpenClaw tool work mount roots for zone '${options.zone.id}'.`,
		);
	}
	return realCandidatePath;
}

function hostAgentOwnedLeaseRoot(options: {
	readonly agentId: string;
	readonly rootId: string;
	readonly zone: ZoneConfig;
}): string | undefined {
	if (options.zone.gateway.type !== 'openclaw') {
		return undefined;
	}
	if (options.rootId === 'openclaw-sandboxes') {
		return path.join(options.zone.gateway.stateDir, 'sandboxes', options.agentId);
	}
	if (options.rootId === 'openclaw-state') {
		return path.join(options.zone.gateway.stateDir, `workspace-${options.agentId}`);
	}
	if (options.rootId === 'zone-files') {
		return path.join(options.zone.gateway.zoneFilesDir, 'agents', options.agentId);
	}
	return undefined;
}

async function assertResolvedLeaseWorkMountKeepsAgentOwnership(options: {
	readonly agentId: string;
	readonly realHostWorkMountDir: string;
	readonly rootId: string;
	readonly workMountDir: string;
	readonly zone: ZoneConfig;
}): Promise<void> {
	const ownedHostRoot = hostAgentOwnedLeaseRoot(options);
	if (ownedHostRoot === undefined) {
		return;
	}
	await assertAgentOwnedRootIsRealDirectory({
		agentId: options.agentId,
		ownedHostRoot,
		workMountDir: options.workMountDir,
	});
	const realOwnedHostRoot = await realpathAllowedRoot(ownedHostRoot);
	if (
		realOwnedHostRoot === null ||
		!isPathWithin(options.realHostWorkMountDir, realOwnedHostRoot)
	) {
		throw new LeaseWorkMountValidationError(
			'work-mount-purpose-not-allowed',
			`Lease workMountDir '${options.workMountDir}' resolves outside the host workspace owned by agent '${options.agentId}'.`,
		);
	}
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
	readonly agentId: string;
	readonly runtimeDir: string;
	readonly workMountDir: string;
	readonly zone: ZoneConfig;
}): Promise<ResolvedLeaseWorkMount> {
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
	const translation = translateRuntimePath({
		inputPath: options.workMountDir,
		mapping: createOpenClawGatewayLeasePathMapping({
			stateDir: options.zone.gateway.stateDir,
			zoneFilesDir: options.zone.gateway.zoneFilesDir,
		}),
		purpose: 'leaseMount',
		sourceNamespace: 'openclaw-gateway',
		targetNamespace: 'controller-host',
	});
	if (!translation.ok) {
		const kind = translatorErrorKindByCode[translation.error.code];
		const message =
			translation.error.code === 'root-path-not-allowed'
				? `Lease workMountDir '${options.workMountDir}' must name a child path under ${OPENCLAW_ZONE_FILES_VM_ROOT} or ${OPENCLAW_STATE_SANDBOXES_VM_ROOT}, not the root itself.`
				: translation.error.message;
		throw new LeaseWorkMountValidationError(kind, message, {
			guidance: translation.error.retryGuidance,
		});
	}
	const agentMismatchMessage = findOpenClawLeaseWorkMountAgentMismatch({
		agentId: options.agentId,
		relativePath: translation.value.relativePath,
		rootId: translation.value.rootId,
		workMountDir: options.workMountDir,
	});
	if (agentMismatchMessage !== undefined) {
		throw new LeaseWorkMountValidationError('work-mount-purpose-not-allowed', agentMismatchMessage);
	}
	const realHostWorkMountDir = await validateResolvedLeaseWorkMountDir({
		hostWorkMountDir: translation.value.outputPath,
		zone: options.zone,
	});
	await assertResolvedLeaseWorkMountKeepsAgentOwnership({
		agentId: options.agentId,
		realHostWorkMountDir,
		rootId: translation.value.rootId,
		workMountDir: options.workMountDir,
		zone: options.zone,
	});
	if (
		isOpenClawZoneGitConfigured(options.zone) &&
		normalizedWorkMountDir.startsWith(`${OPENCLAW_ZONE_FILES_VM_ROOT}/`)
	) {
		const zoneGitPaths = resolveZoneGitPaths({
			runtimeDir: options.runtimeDir,
			zoneId: options.zone.id,
		});
		return {
			guestWorkdir: normalizedWorkMountDir,
			hostWorkMountDir: realHostWorkMountDir,
			zoneGitMount: {
				hostZoneFilesDir: options.zone.gateway.zoneFilesDir,
				hostZoneGitRoot: zoneGitPaths.hostZoneGitRoot,
			},
		};
	}
	return {
		guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
		hostWorkMountDir: realHostWorkMountDir,
	};
}
