import {
	OPENCLAW_STATE_SANDBOXES_VM_ROOT,
	TOOL_VM_SCRATCH_GUEST_ROOT,
	TOOL_VM_WORKSPACE_GUEST_ROOT,
	translateRuntimePath,
	type RuntimePathMapping,
	type RuntimePathTranslation,
	type RuntimePathTranslationError,
} from '@agent-vm/gateway-contracts';

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
				backing: {
					kind: 'host-realfs',
					durability: 'durable',
					backup: 'included',
				},
				capabilities: {
					executionCwd: true,
					leaseMount: true,
				},
				locations: {
					'openclaw-gateway': options.agentWorkspaceDir,
					'tool-vm-guest': TOOL_VM_WORKSPACE_GUEST_ROOT,
				},
				rootPathAllowed: true,
				guidanceLabel: 'agent workspace',
			},
			{
				id: 'tool-vm-scratch',
				backing: {
					kind: 'guest-rootfs-cow',
					durability: 'vm-lifetime',
				},
				capabilities: {
					executionCwd: true,
					leaseMount: false,
				},
				locations: {
					'tool-vm-guest': TOOL_VM_SCRATCH_GUEST_ROOT,
				},
				rootPathAllowed: true,
				guidanceLabel: 'Tool VM scratch',
			},
			{
				id: 'openclaw-sandboxes',
				backing: {
					kind: 'host-realfs',
					durability: 'durable',
					backup: 'included',
				},
				capabilities: {
					executionCwd: true,
					leaseMount: true,
				},
				locations: {
					'openclaw-gateway': OPENCLAW_STATE_SANDBOXES_VM_ROOT,
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
			? translation.outputPath
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
	if (translation.inputNamespace === 'openclaw-gateway') {
		return isRoot ? 'host-workspace-root' : 'host-workspace-subpath';
	}
	return isRoot ? 'workspace-root' : 'workspace-subpath';
}

function leaseRootForTranslation(translation: RuntimePathTranslation): string {
	return translation.relativePath === ''
		? translation.outputPath
		: translation.outputPath.slice(0, -(translation.relativePath.length + 1));
}

export function resolveOpenClawToolVmPathIntent(options: {
	readonly agentWorkspaceDir: string;
	readonly equivalentAgentWorkspaceDirs?: readonly string[];
	readonly inputPath: string;
}): OpenClawToolVmPathIntentResult {
	const agentWorkspaceDirError = validateAgentWorkspaceDir(options.agentWorkspaceDir);
	if (agentWorkspaceDirError !== undefined) {
		return {
			error: agentWorkspaceDirError,
			ok: false,
		};
	}
	const mappings = [
		createOpenClawToolVmPathMapping({
			agentWorkspaceDir: options.agentWorkspaceDir,
		}),
		...(options.equivalentAgentWorkspaceDirs ?? []).map((equivalentAgentWorkspaceDir) =>
			createOpenClawToolVmPathMapping({
				agentWorkspaceDir: equivalentAgentWorkspaceDir,
			}),
		),
	];
	const invalidEquivalentRoot = (options.equivalentAgentWorkspaceDirs ?? [])
		.map((equivalentAgentWorkspaceDir) => validateAgentWorkspaceDir(equivalentAgentWorkspaceDir))
		.find((error) => error !== undefined);
	if (invalidEquivalentRoot !== undefined) {
		return {
			error: invalidEquivalentRoot,
			ok: false,
		};
	}
	const mapping = createOpenClawToolVmPathMapping({
		agentWorkspaceDir: options.agentWorkspaceDir,
	});
	const sandboxTranslation = translateRuntimePath({
		inputPath: options.inputPath,
		mapping,
		purpose: 'executionCwd',
		sourceNamespace: 'openclaw-gateway',
		targetNamespace: 'openclaw-gateway',
	});
	if (sandboxTranslation.ok && sandboxTranslation.value.rootId === 'openclaw-sandboxes') {
		const sandboxPathIntent = resolveOpenClawSandboxPathIntent(sandboxTranslation.value);
		return {
			ok: true,
			value: {
				effectiveGuestCwd: sandboxPathIntent.effectiveGuestCwd,
				hostEquivalentPath: sandboxTranslation.value.outputPath,
				kind: kindForTranslation(sandboxTranslation.value),
				leaseWorkMountDir: sandboxPathIntent.leaseWorkMountDir,
			},
		};
	}
	const translationResults = mappings.map((candidateMapping) =>
		translateRuntimePath({
			inputPath: options.inputPath,
			mapping: candidateMapping,
			purpose: 'executionCwd',
			targetNamespace: 'tool-vm-guest',
		}),
	);
	const translation = translationResults.find((candidateTranslation) => candidateTranslation.ok);
	if (translation === undefined) {
		const primaryTranslation = translationResults[0];
		if (primaryTranslation === undefined || primaryTranslation.ok) {
			return {
				error: invalidAgentWorkspaceRootError(options.agentWorkspaceDir),
				ok: false,
			};
		}
		return primaryTranslation;
	}
	const hostEquivalentTranslation = translateRuntimePath({
		inputPath: options.inputPath,
		mapping,
		purpose: 'executionCwd',
		targetNamespace: 'openclaw-gateway',
	});
	return {
		ok: true,
		value: {
			effectiveGuestCwd: translation.value.outputPath,
			...(hostEquivalentTranslation.ok
				? { hostEquivalentPath: hostEquivalentTranslation.value.outputPath }
				: {}),
			kind: kindForTranslation(translation.value),
			leaseWorkMountDir:
				hostEquivalentTranslation.ok && hostEquivalentTranslation.value.rootId !== 'tool-vm-scratch'
					? leaseRootForTranslation(hostEquivalentTranslation.value)
					: options.agentWorkspaceDir,
		},
	};
}

export function assertOpenClawToolVmPathIntent(options: {
	readonly agentWorkspaceDir: string;
	readonly equivalentAgentWorkspaceDirs?: readonly string[];
	readonly inputPath: string;
}): OpenClawToolVmPathIntentResolution {
	const result = resolveOpenClawToolVmPathIntent(options);
	if (!result.ok) {
		throw new OpenClawToolVmPathIntentError(result.error);
	}
	return result.value;
}
