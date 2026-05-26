import path from 'node:path/posix';

import {
	OPENCLAW_STATE_SANDBOXES_VM_ROOT,
	TOOL_VM_SCRATCH_GUEST_ROOT,
	TOOL_VM_WORKSPACE_GUEST_ROOT,
} from '@agent-vm/gateway-interface';

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
	| 'state-default-workspace'
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

function isRuntimePathLeak(inputPath: string): boolean {
	const normalized = normalizeAbsolutePosixPath(inputPath);
	return (
		normalized === TOOL_VM_WORKSPACE_GUEST_ROOT ||
		normalized.startsWith(`${TOOL_VM_WORKSPACE_GUEST_ROOT}/`) ||
		normalized === TOOL_VM_SCRATCH_GUEST_ROOT ||
		normalized.startsWith(`${TOOL_VM_SCRATCH_GUEST_ROOT}/`) ||
		normalized === OPENCLAW_STATE_SANDBOXES_VM_ROOT ||
		normalized.startsWith(`${OPENCLAW_STATE_SANDBOXES_VM_ROOT}/`)
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
	if (inputPath.trim() === '' || containsParentTraversal(inputPath)) {
		throw new OpenClawAgentWorkspaceSourceError(
			`${context} must be a non-empty path without parent traversal.`,
		);
	}
	const resolvedPath = resolveUserPathLikeOpenClaw(inputPath);
	if (!resolvedPath.startsWith('/')) {
		throw new OpenClawAgentWorkspaceSourceError(`${context} must resolve to an absolute path.`);
	}
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
			sourceDir: assertCanonicalSourcePath(
				agentWorkspace,
				`agents.list workspace for '${agentId}'`,
			),
		};
	}

	const defaultsWorkspace = readWorkspace(options.openClawConfig?.agents?.defaults?.workspace);
	if (defaultsWorkspace !== undefined) {
		const defaultsRoot = assertCanonicalSourcePath(defaultsWorkspace, 'agents.defaults.workspace');
		const defaultAgentId = resolveDefaultAgentId(options.openClawConfig);
		return {
			kind: agentId === defaultAgentId ? 'default-agent-workspace' : 'default-workspace-child',
			sourceDir: agentId === defaultAgentId ? defaultsRoot : path.join(defaultsRoot, agentId),
		};
	}

	if (!isRuntimePathLeak(options.paramsAgentWorkspaceDir)) {
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
	const defaultWorkspace =
		options.defaultWorkspaceDir === undefined
			? undefined
			: assertCanonicalSourcePath(
					options.defaultWorkspaceDir,
					'OpenClaw default workspace directory',
				);
	if (stateRoot === undefined || defaultWorkspace === undefined) {
		throw new OpenClawAgentWorkspaceSourceError(
			`OpenClaw provided agentWorkspaceDir '${options.paramsAgentWorkspaceDir}' for agent '${agentId}', which is a runtime path. Provide OpenClaw stateDir/defaultWorkspaceDir providers or configure agents.list[].workspace.`,
		);
	}

	const defaultAgentId = resolveDefaultAgentId(options.openClawConfig);
	return {
		kind: agentId === defaultAgentId ? 'state-default-workspace' : 'state-workspace-child',
		sourceDir:
			agentId === defaultAgentId ? defaultWorkspace : path.join(stateRoot, `workspace-${agentId}`),
	};
}
