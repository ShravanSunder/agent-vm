import path from 'node:path/posix';

import {
	OPENCLAW_STATE_SANDBOXES_VM_ROOT,
	TOOL_VM_SCRATCH_GUEST_ROOT,
	TOOL_VM_WORKSPACE_GUEST_ROOT,
} from '@agent-vm/gateway-contracts';

import { normalizeOpenClawAgentId } from '../openclaw-gondolin-contract.js';

export interface OpenClawAgentWorkspaceConfig {
	readonly agents?: {
		readonly defaults?: {
			readonly workspace?: unknown;
		};
		readonly list?: readonly unknown[];
	};
}

export type OpenClawAgentWorkspaceSourceKind =
	| 'configured-agent-workspace'
	| 'default-agent-workspace'
	| 'default-workspace-child'
	| 'sdk-agent-workspace'
	| 'state-workspace-child';

export interface OpenClawAgentWorkspaceSource {
	readonly kind: OpenClawAgentWorkspaceSourceKind;
	readonly sourceDir: string;
}

export class OpenClawAgentWorkspaceSourceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'OpenClawAgentWorkspaceSourceError';
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeAbsolutePosixPath(inputPath: string): string {
	const segments = inputPath.split('/').filter((segment) => segment !== '' && segment !== '.');
	return `/${segments.join('/')}`;
}

function containsParentTraversal(inputPath: string): boolean {
	return inputPath.split(/\/+/u).includes('..');
}

function pathIsInsideOrEqual(inputPath: string, rootPath: string): boolean {
	return inputPath === rootPath || inputPath.startsWith(`${rootPath}/`);
}

function isRuntimePathLeak(inputPath: string, defaultWorkspaceDir: string | undefined): boolean {
	const normalized = normalizeAbsolutePosixPath(inputPath);
	const normalizedDefaultWorkspace =
		defaultWorkspaceDir === undefined
			? undefined
			: normalizeAbsolutePosixPath(resolveUserPathLikeOpenClaw(defaultWorkspaceDir));
	const implicitWorkspaceFamilyRoot =
		normalizedDefaultWorkspace === undefined
			? undefined
			: normalizedDefaultWorkspace.replace(/(?:-[^/]+)?$/u, '');
	return (
		normalized === TOOL_VM_WORKSPACE_GUEST_ROOT ||
		normalized.startsWith(`${TOOL_VM_WORKSPACE_GUEST_ROOT}/`) ||
		normalized === TOOL_VM_SCRATCH_GUEST_ROOT ||
		normalized.startsWith(`${TOOL_VM_SCRATCH_GUEST_ROOT}/`) ||
		normalized === OPENCLAW_STATE_SANDBOXES_VM_ROOT ||
		normalized.startsWith(`${OPENCLAW_STATE_SANDBOXES_VM_ROOT}/`) ||
		(normalizedDefaultWorkspace !== undefined &&
			(pathIsInsideOrEqual(normalized, normalizedDefaultWorkspace) ||
				normalized.startsWith(`${normalizedDefaultWorkspace}-`))) ||
		(implicitWorkspaceFamilyRoot !== undefined &&
			(pathIsInsideOrEqual(normalized, implicitWorkspaceFamilyRoot) ||
				normalized.startsWith(`${implicitWorkspaceFamilyRoot}-`)))
	);
}

function resolveUserPathLikeOpenClaw(inputPath: string): string {
	const trimmedPath = inputPath.trim();
	const homeDirectory = process.env.HOME?.trim();
	if (trimmedPath === '~' && homeDirectory) {
		return homeDirectory;
	}
	if (trimmedPath.startsWith('~/') && homeDirectory) {
		return path.resolve(path.join(homeDirectory, trimmedPath.slice(2)));
	}
	return path.resolve(trimmedPath);
}

function assertCanonicalSourcePath(inputPath: string, context: string): string {
	const trimmedPath = inputPath.trim();
	if (trimmedPath === '' || containsParentTraversal(trimmedPath)) {
		throw new OpenClawAgentWorkspaceSourceError(
			`${context} must be a non-empty path without parent traversal.`,
		);
	}
	if (!trimmedPath.startsWith('/') && !trimmedPath.startsWith('~')) {
		throw new OpenClawAgentWorkspaceSourceError(
			`${context} must be an absolute or home-relative path.`,
		);
	}
	const resolvedPath = resolveUserPathLikeOpenClaw(trimmedPath);
	const normalized = normalizeAbsolutePosixPath(resolvedPath);
	if (
		normalized === '/' ||
		normalized === TOOL_VM_WORKSPACE_GUEST_ROOT ||
		normalized.startsWith(`${TOOL_VM_WORKSPACE_GUEST_ROOT}/`) ||
		normalized === TOOL_VM_SCRATCH_GUEST_ROOT ||
		normalized.startsWith(`${TOOL_VM_SCRATCH_GUEST_ROOT}/`)
	) {
		throw new OpenClawAgentWorkspaceSourceError(
			`${context} must resolve to an OpenClaw/Gondolin source path, not Tool VM guest path '${normalized}'.`,
		);
	}
	if (
		normalized === OPENCLAW_STATE_SANDBOXES_VM_ROOT ||
		normalized.startsWith(`${OPENCLAW_STATE_SANDBOXES_VM_ROOT}/`)
	) {
		throw new OpenClawAgentWorkspaceSourceError(
			`${context} must resolve to a stable agent workspace path, not transient OpenClaw sandbox path '${normalized}'.`,
		);
	}
	return normalized;
}

function assertLeaseBackedSourcePath(
	inputPath: string,
	context: string,
	defaultWorkspaceDir: string | undefined,
): string {
	const normalized = assertCanonicalSourcePath(inputPath, context);
	if (isRuntimePathLeak(normalized, defaultWorkspaceDir)) {
		throw new OpenClawAgentWorkspaceSourceError(
			`${context} must resolve to a controller lease-backed OpenClaw/Gondolin source path, not OpenClaw runtime fallback path '${normalized}'.`,
		);
	}
	return normalized;
}

function readWorkspace(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function readAgentId(value: unknown): string {
	return normalizeOpenClawAgentId(typeof value === 'string' ? value : undefined);
}

function agentEntries(
	config: OpenClawAgentWorkspaceConfig | undefined,
): readonly Record<string, unknown>[] {
	return config?.agents?.list?.filter(isRecord) ?? [];
}

function findAgentEntry(
	config: OpenClawAgentWorkspaceConfig | undefined,
	agentId: string,
): Record<string, unknown> | undefined {
	return agentEntries(config).find((entry) => readAgentId(entry.id) === agentId);
}

function resolveDefaultAgentId(config: OpenClawAgentWorkspaceConfig | undefined): string {
	const entries = agentEntries(config);
	const defaultEntry = entries.find((entry) => entry.default === true);
	const fallbackEntry = defaultEntry ?? entries[0];
	return readAgentId(fallbackEntry?.id);
}

export function resolveOpenClawAgentWorkspaceSource(options: {
	readonly agentId: string;
	readonly defaultWorkspaceDir: string | undefined;
	readonly openClawConfig: OpenClawAgentWorkspaceConfig | undefined;
	readonly paramsAgentWorkspaceDir: string;
	readonly stateDir: string | undefined;
}): OpenClawAgentWorkspaceSource {
	const agentId = normalizeOpenClawAgentId(options.agentId);
	const agentEntry = findAgentEntry(options.openClawConfig, agentId);
	const agentWorkspace = readWorkspace(agentEntry?.workspace);
	if (agentWorkspace !== undefined) {
		return {
			kind: 'configured-agent-workspace',
			sourceDir: assertLeaseBackedSourcePath(
				agentWorkspace,
				`agents.list workspace for '${agentId}'`,
				options.defaultWorkspaceDir,
			),
		};
	}

	const defaultsWorkspace = readWorkspace(options.openClawConfig?.agents?.defaults?.workspace);
	if (defaultsWorkspace !== undefined) {
		const defaultsRoot = assertLeaseBackedSourcePath(
			defaultsWorkspace,
			'agents.defaults.workspace',
			options.defaultWorkspaceDir,
		);
		const defaultAgentId = resolveDefaultAgentId(options.openClawConfig);
		return {
			kind: agentId === defaultAgentId ? 'default-agent-workspace' : 'default-workspace-child',
			sourceDir: agentId === defaultAgentId ? defaultsRoot : path.join(defaultsRoot, agentId),
		};
	}

	if (!isRuntimePathLeak(options.paramsAgentWorkspaceDir, options.defaultWorkspaceDir)) {
		return {
			kind: 'sdk-agent-workspace',
			sourceDir: assertCanonicalSourcePath(
				options.paramsAgentWorkspaceDir,
				'OpenClaw backend agentWorkspaceDir',
			),
		};
	}

	const stateRoot =
		options.stateDir === undefined
			? undefined
			: assertCanonicalSourcePath(options.stateDir, 'OpenClaw stateDir');
	if (stateRoot === undefined) {
		throw new OpenClawAgentWorkspaceSourceError(
			`OpenClaw provided agentWorkspaceDir '${options.paramsAgentWorkspaceDir}' for agent '${agentId}', which is a runtime path. Provide an OpenClaw stateDir provider or configure agents.list[].workspace.`,
		);
	}

	const defaultAgentId = resolveDefaultAgentId(options.openClawConfig);
	if (agentId === defaultAgentId) {
		throw new OpenClawAgentWorkspaceSourceError(
			`OpenClaw provided agentWorkspaceDir '${options.paramsAgentWorkspaceDir}' for default agent '${agentId}', but OpenClaw's implicit default workspace is not controller lease backed; configure agents.list[].workspace or agents.defaults.workspace for managed Gondolin agents.`,
		);
	}
	return {
		kind: 'state-workspace-child',
		sourceDir: path.join(stateRoot, `workspace-${agentId}`),
	};
}
