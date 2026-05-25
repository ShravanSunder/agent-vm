import {
	OPENCLAW_STATE_SANDBOXES_VM_ROOT,
	TOOL_VM_SCRATCH_GUEST_ROOT,
	TOOL_VM_WORKSPACE_GUEST_ROOT,
	translateRuntimePath,
	type RuntimePathMapping,
	type RuntimePathTranslation,
	type RuntimePathTranslationError,
} from '@agent-vm/gateway-interface';

export type OpenClawToolVmPathIntentKind =
	| 'host-workspace-root'
	| 'host-workspace-subpath'
	| 'openclaw-sandbox-path'
	| 'workspace-root'
	| 'workspace-subpath'
	| 'scratch-root'
	| 'scratch-subpath';

export interface OpenClawToolVmPathIntentResolution {
	readonly effectiveGuestCwd: string;
	readonly hostEquivalentPath?: string;
	readonly kind: OpenClawToolVmPathIntentKind;
	readonly leaseWorkMountDir: string;
}

export type OpenClawToolVmPathIntentResult =
	| {
			readonly ok: true;
			readonly value: OpenClawToolVmPathIntentResolution;
	  }
	| {
			readonly ok: false;
			readonly error: RuntimePathTranslationError;
	  };

export class OpenClawToolVmPathIntentError extends Error {
	readonly details: RuntimePathTranslationError;

	constructor(details: RuntimePathTranslationError) {
		super(`${details.message} ${details.retryGuidance}`);
		this.name = 'OpenClawToolVmPathIntentError';
		this.details = details;
	}
}

function pathContainsParentTraversal(inputPath: string): boolean {
	return inputPath.split(/\/+/u).includes('..');
}

function normalizedAbsolutePath(inputPath: string): string {
	const rawSegments = inputPath.split('/').filter((segment) => segment !== '' && segment !== '.');
	return `/${rawSegments.join('/')}`;
}

function invalidAgentWorkspaceRootError(agentWorkspaceDir: string): RuntimePathTranslationError {
	return {
		allowedPathForms: [],
		code: 'invalid-runtime-root',
		inputPath: agentWorkspaceDir,
		mappingId: 'openclaw-tool-vm',
		message: `OpenClaw agentWorkspaceDir '${agentWorkspaceDir}' must be an absolute non-root path without parent traversal.`,
		purpose: 'executionCwd',
		retryGuidance:
			'Retry with OpenClaw agentWorkspaceDir set to the resolved host RealFS workspace for the requested agent.',
	};
}

function validateAgentWorkspaceDir(
	agentWorkspaceDir: string,
): RuntimePathTranslationError | undefined {
	if (
		agentWorkspaceDir.trim() === '' ||
		!agentWorkspaceDir.startsWith('/') ||
		normalizedAbsolutePath(agentWorkspaceDir) === '/' ||
		pathContainsParentTraversal(agentWorkspaceDir)
	) {
		return invalidAgentWorkspaceRootError(agentWorkspaceDir);
	}
	return undefined;
}

function createOpenClawToolVmPathMapping(options: {
	readonly agentWorkspaceDir: string;
}): RuntimePathMapping {
	return {
		id: 'openclaw-tool-vm',
		roots: [
			{
				id: 'agent-workspace',
				guestRoot: TOOL_VM_WORKSPACE_GUEST_ROOT,
				hostRoot: options.agentWorkspaceDir,
				backing: {
					kind: 'host-realfs',
					durability: 'durable',
					backup: 'included',
				},
				capabilities: {
					executionCwd: true,
					leaseMount: true,
				},
				rootPathAllowed: true,
				guidanceLabel: 'agent workspace',
			},
			{
				id: 'tool-vm-scratch',
				guestRoot: TOOL_VM_SCRATCH_GUEST_ROOT,
				backing: {
					kind: 'guest-rootfs-cow',
					durability: 'vm-lifetime',
				},
				capabilities: {
					executionCwd: true,
					leaseMount: false,
				},
				rootPathAllowed: true,
				guidanceLabel: 'Tool VM scratch',
			},
			{
				id: 'openclaw-sandboxes',
				hostRoot: OPENCLAW_STATE_SANDBOXES_VM_ROOT,
				backing: {
					kind: 'host-realfs',
					durability: 'durable',
					backup: 'included',
				},
				capabilities: {
					executionCwd: true,
					leaseMount: true,
				},
				rootPathAllowed: false,
				guidanceLabel: 'OpenClaw sandbox work directory',
			},
		],
	};
}

function resolveOpenClawSandboxPathIntent(translation: RuntimePathTranslation): {
	readonly effectiveGuestCwd: string;
	readonly leaseWorkMountDir: string;
} {
	const [sandboxChild, ...guestCwdSegments] = translation.relativePath.split('/');
	const leaseWorkMountDir =
		sandboxChild === undefined || sandboxChild === ''
			? (translation.hostPath ?? OPENCLAW_STATE_SANDBOXES_VM_ROOT)
			: `${OPENCLAW_STATE_SANDBOXES_VM_ROOT}/${sandboxChild}`;
	const effectiveGuestCwd =
		guestCwdSegments.length === 0
			? TOOL_VM_WORKSPACE_GUEST_ROOT
			: `${TOOL_VM_WORKSPACE_GUEST_ROOT}/${guestCwdSegments.join('/')}`;
	return {
		effectiveGuestCwd,
		leaseWorkMountDir,
	};
}

function kindForTranslation(translation: RuntimePathTranslation): OpenClawToolVmPathIntentKind {
	const isRoot = translation.relativePath === '';
	if (translation.rootId === 'tool-vm-scratch') {
		return isRoot ? 'scratch-root' : 'scratch-subpath';
	}
	if (translation.rootId === 'openclaw-sandboxes') {
		return 'openclaw-sandbox-path';
	}
	if (translation.inputNamespace === 'host') {
		return isRoot ? 'host-workspace-root' : 'host-workspace-subpath';
	}
	return isRoot ? 'workspace-root' : 'workspace-subpath';
}

export function resolveOpenClawToolVmPathIntent(options: {
	readonly agentWorkspaceDir: string;
	readonly inputPath: string;
}): OpenClawToolVmPathIntentResult {
	const agentWorkspaceDirError = validateAgentWorkspaceDir(options.agentWorkspaceDir);
	if (agentWorkspaceDirError !== undefined) {
		return {
			error: agentWorkspaceDirError,
			ok: false,
		};
	}
	const translation = translateRuntimePath({
		inputPath: options.inputPath,
		mapping: createOpenClawToolVmPathMapping({
			agentWorkspaceDir: options.agentWorkspaceDir,
		}),
		purpose: 'executionCwd',
	});
	if (!translation.ok) {
		return translation;
	}
	const sandboxPathIntent =
		translation.value.rootId === 'openclaw-sandboxes'
			? resolveOpenClawSandboxPathIntent(translation.value)
			: undefined;
	return {
		ok: true,
		value: {
			effectiveGuestCwd:
				sandboxPathIntent !== undefined
					? sandboxPathIntent.effectiveGuestCwd
					: (translation.value.guestPath ?? TOOL_VM_WORKSPACE_GUEST_ROOT),
			...(translation.value.hostPath !== undefined
				? { hostEquivalentPath: translation.value.hostPath }
				: {}),
			kind: kindForTranslation(translation.value),
			leaseWorkMountDir:
				sandboxPathIntent !== undefined
					? sandboxPathIntent.leaseWorkMountDir
					: (translation.value.hostRoot ?? options.agentWorkspaceDir),
		},
	};
}

export function assertOpenClawToolVmPathIntent(options: {
	readonly agentWorkspaceDir: string;
	readonly inputPath: string;
}): OpenClawToolVmPathIntentResolution {
	const result = resolveOpenClawToolVmPathIntent(options);
	if (!result.ok) {
		throw new OpenClawToolVmPathIntentError(result.error);
	}
	return result.value;
}
