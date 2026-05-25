import {
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
		],
	};
}

function kindForTranslation(translation: RuntimePathTranslation): OpenClawToolVmPathIntentKind {
	const isRoot = translation.relativePath === '';
	if (translation.rootId === 'tool-vm-scratch') {
		return isRoot ? 'scratch-root' : 'scratch-subpath';
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
	return {
		ok: true,
		value: {
			effectiveGuestCwd: translation.value.guestPath ?? TOOL_VM_WORKSPACE_GUEST_ROOT,
			...(translation.value.hostPath !== undefined
				? { hostEquivalentPath: translation.value.hostPath }
				: {}),
			kind: kindForTranslation(translation.value),
			leaseWorkMountDir: translation.value.hostRoot ?? options.agentWorkspaceDir,
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
