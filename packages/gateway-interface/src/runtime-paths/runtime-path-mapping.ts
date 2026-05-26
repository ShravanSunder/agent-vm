export const TOOL_VM_WORKSPACE_GUEST_ROOT = '/workspace';
export const TOOL_VM_SCRATCH_GUEST_ROOT = '/work';
export const OPENCLAW_STATE_VM_ROOT = '/home/openclaw/.openclaw/state';
export const OPENCLAW_STATE_SANDBOXES_VM_ROOT = `${OPENCLAW_STATE_VM_ROOT}/sandboxes`;

export type RuntimePathNamespace = 'controller-host' | 'openclaw-gateway' | 'tool-vm-guest';
export type RuntimePathPurpose = 'executionCwd' | 'leaseMount';

export interface RuntimePathCapabilities {
	readonly executionCwd: boolean;
	readonly leaseMount: boolean;
}

export type RuntimePathBacking =
	| {
			readonly kind: 'host-realfs';
			readonly durability: 'durable' | 'runtime' | 'cache';
			readonly backup: 'included' | 'excluded';
	  }
	| {
			readonly kind: 'guest-rootfs-cow';
			readonly durability: 'vm-lifetime';
	  };

export type RuntimePathLocations = Partial<Record<RuntimePathNamespace, string>>;
export type RuntimePathGuidanceVisibility = Partial<Record<RuntimePathNamespace, boolean>>;

export interface RuntimePathRootMapping {
	readonly backing: RuntimePathBacking;
	readonly capabilities: RuntimePathCapabilities;
	readonly guidanceLabel: string;
	readonly id: string;
	readonly locations: RuntimePathLocations;
	readonly rootPathAllowed: boolean;
	readonly showInGuidance?: RuntimePathGuidanceVisibility;
}

export interface RuntimePathMapping {
	readonly id: string;
	readonly roots: readonly RuntimePathRootMapping[];
}

export interface TranslateRuntimePathInput {
	readonly inputPath: string;
	readonly mapping: RuntimePathMapping;
	readonly purpose: RuntimePathPurpose;
	readonly sourceNamespace?: RuntimePathNamespace;
	readonly targetNamespace: RuntimePathNamespace;
}

export interface RuntimePathTranslation {
	readonly backing: RuntimePathBacking;
	readonly capabilities: RuntimePathCapabilities;
	readonly inputNamespace: RuntimePathNamespace;
	readonly inputPath: string;
	readonly mappingId: string;
	readonly outputNamespace: RuntimePathNamespace;
	readonly outputPath: string;
	readonly relativePath: string;
	readonly rootId: string;
}

export type RuntimePathTranslationErrorCode =
	| 'path-not-absolute'
	| 'path-parent-traversal'
	| 'invalid-runtime-root'
	| 'unknown-runtime-path'
	| 'purpose-not-allowed'
	| 'root-path-not-allowed'
	| 'target-namespace-not-available';

export interface RuntimePathTranslationError {
	readonly allowedPathForms: readonly string[];
	readonly code: RuntimePathTranslationErrorCode;
	readonly inputPath: string;
	readonly mappingId: string;
	readonly message: string;
	readonly purpose: RuntimePathPurpose;
	readonly retryGuidance: string;
}

export type TranslateRuntimePathResult =
	| {
			readonly ok: true;
			readonly value: RuntimePathTranslation;
	  }
	| {
			readonly ok: false;
			readonly error: RuntimePathTranslationError;
	  };

interface RuntimePathRootMatch {
	readonly inputNamespace: RuntimePathNamespace;
	readonly matchedRoot: string;
	readonly root: RuntimePathRootMapping;
}

const guidanceNamespaceOrder = [
	'tool-vm-guest',
	'openclaw-gateway',
	'controller-host',
] as const satisfies readonly RuntimePathNamespace[];

function pathContainsParentTraversal(inputPath: string): boolean {
	return inputPath.split(/\/+/u).includes('..');
}

function normalizeAbsolutePath(inputPath: string): string {
	const rawSegments = inputPath.split('/').filter((segment) => segment !== '' && segment !== '.');
	return `/${rawSegments.join('/')}`;
}

function normalizeRoot(rootPath: string): string {
	const normalizedRoot = normalizeAbsolutePath(rootPath);
	return normalizedRoot === '/' ? normalizedRoot : normalizedRoot.replace(/\/+$/u, '');
}

function pathMatchesRoot(candidatePath: string, rootPath: string): boolean {
	return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);
}

function relativePathForRoot(candidatePath: string, rootPath: string): string {
	return candidatePath === rootPath ? '' : candidatePath.slice(rootPath.length + 1);
}

function joinRootAndRelative(rootPath: string, relativePath: string): string {
	return relativePath === '' ? rootPath : `${rootPath}/${relativePath}`;
}

function runtimeRootIsInvalid(rootPath: string): boolean {
	return (
		rootPath.trim() === '' || !rootPath.startsWith('/') || pathContainsParentTraversal(rootPath)
	);
}

function namespaceShouldShowInGuidance(
	root: RuntimePathRootMapping,
	namespace: RuntimePathNamespace,
): boolean {
	if (root.showInGuidance?.[namespace] !== undefined) {
		return root.showInGuidance[namespace] === true;
	}
	return namespace !== 'controller-host';
}

function allowedPathFormsForMapping(
	mapping: RuntimePathMapping,
	purpose: RuntimePathPurpose,
): readonly string[] {
	return mapping.roots.flatMap((root) => {
		if (!root.capabilities[purpose]) {
			return [];
		}
		const suffix = root.rootPathAllowed ? '[/subpath]' : '/<child>';
		return guidanceNamespaceOrder.flatMap((namespace): string[] => {
			const rootPath = root.locations[namespace];
			if (rootPath === undefined || !namespaceShouldShowInGuidance(root, namespace)) {
				return [];
			}
			return [`${normalizeRoot(rootPath)}${suffix}`];
		});
	});
}

function retryGuidanceForMapping(mapping: RuntimePathMapping, purpose: RuntimePathPurpose): string {
	return `Use one of the allowed path forms for ${mapping.id} ${purpose}: ${allowedPathFormsForMapping(mapping, purpose).join(', ')}.`;
}

function errorResult(params: {
	readonly code: RuntimePathTranslationErrorCode;
	readonly inputPath: string;
	readonly mapping: RuntimePathMapping;
	readonly message: string;
	readonly purpose: RuntimePathPurpose;
}): TranslateRuntimePathResult {
	return {
		error: {
			allowedPathForms: allowedPathFormsForMapping(params.mapping, params.purpose),
			code: params.code,
			inputPath: params.inputPath,
			mappingId: params.mapping.id,
			message: params.message,
			purpose: params.purpose,
			retryGuidance: retryGuidanceForMapping(params.mapping, params.purpose),
		},
		ok: false,
	};
}

function findBestRootMatch(params: {
	readonly inputPath: string;
	readonly mapping: RuntimePathMapping;
	readonly sourceNamespace?: RuntimePathNamespace;
}): RuntimePathRootMatch | undefined {
	const matches = params.mapping.roots.flatMap((root): RuntimePathRootMatch[] =>
		Object.entries(root.locations).flatMap(([namespace, rootPath]) => {
			if (rootPath === undefined) {
				return [];
			}
			const inputNamespace = namespace as RuntimePathNamespace;
			if (params.sourceNamespace !== undefined && inputNamespace !== params.sourceNamespace) {
				return [];
			}
			const normalizedRoot = normalizeRoot(rootPath);
			return pathMatchesRoot(params.inputPath, normalizedRoot)
				? [{ inputNamespace, matchedRoot: normalizedRoot, root }]
				: [];
		}),
	);
	return matches.toSorted((left, right) => right.matchedRoot.length - left.matchedRoot.length)[0];
}

function findInvalidRoot(
	mapping: RuntimePathMapping,
): { readonly rootId: string; readonly rootPath: string } | undefined {
	for (const root of mapping.roots) {
		for (const rootPath of Object.values(root.locations)) {
			if (rootPath !== undefined && runtimeRootIsInvalid(rootPath)) {
				return { rootId: root.id, rootPath };
			}
		}
	}
	return undefined;
}

export function translateRuntimePath(input: TranslateRuntimePathInput): TranslateRuntimePathResult {
	if (!input.inputPath.startsWith('/')) {
		return errorResult({
			code: 'path-not-absolute',
			inputPath: input.inputPath,
			mapping: input.mapping,
			message: `Path '${input.inputPath}' must be absolute.`,
			purpose: input.purpose,
		});
	}
	if (pathContainsParentTraversal(input.inputPath)) {
		return errorResult({
			code: 'path-parent-traversal',
			inputPath: input.inputPath,
			mapping: input.mapping,
			message: `Path '${input.inputPath}' must not contain parent traversal.`,
			purpose: input.purpose,
		});
	}
	const invalidRoot = findInvalidRoot(input.mapping);
	if (invalidRoot !== undefined) {
		return errorResult({
			code: 'invalid-runtime-root',
			inputPath: input.inputPath,
			mapping: input.mapping,
			message: `Runtime path root '${invalidRoot.rootId}' has invalid path '${invalidRoot.rootPath}'.`,
			purpose: input.purpose,
		});
	}
	const normalizedInputPath = normalizeAbsolutePath(input.inputPath);
	const match = findBestRootMatch({
		inputPath: normalizedInputPath,
		mapping: input.mapping,
		...(input.sourceNamespace === undefined ? {} : { sourceNamespace: input.sourceNamespace }),
	});
	if (match === undefined) {
		return errorResult({
			code: 'unknown-runtime-path',
			inputPath: normalizedInputPath,
			mapping: input.mapping,
			message: `Path '${normalizedInputPath}' is not part of runtime path mapping '${input.mapping.id}'.`,
			purpose: input.purpose,
		});
	}
	const relativePath = relativePathForRoot(normalizedInputPath, match.matchedRoot);
	if (relativePath === '' && !match.root.rootPathAllowed) {
		return errorResult({
			code: 'root-path-not-allowed',
			inputPath: normalizedInputPath,
			mapping: input.mapping,
			message: `Path '${normalizedInputPath}' matched ${match.root.guidanceLabel}, but the root itself is not allowed for ${input.purpose}.`,
			purpose: input.purpose,
		});
	}
	if (!match.root.capabilities[input.purpose]) {
		return errorResult({
			code: 'purpose-not-allowed',
			inputPath: normalizedInputPath,
			mapping: input.mapping,
			message: `Path '${normalizedInputPath}' matched ${match.root.guidanceLabel} but cannot be used for ${input.purpose}.`,
			purpose: input.purpose,
		});
	}
	const targetRoot = match.root.locations[input.targetNamespace];
	if (targetRoot === undefined) {
		return errorResult({
			code: 'target-namespace-not-available',
			inputPath: normalizedInputPath,
			mapping: input.mapping,
			message: `Path '${normalizedInputPath}' matched ${match.root.guidanceLabel}, but '${input.targetNamespace}' is not available for that root.`,
			purpose: input.purpose,
		});
	}
	const normalizedTargetRoot = normalizeRoot(targetRoot);
	return {
		ok: true,
		value: {
			backing: match.root.backing,
			capabilities: match.root.capabilities,
			inputNamespace: match.inputNamespace,
			inputPath: normalizedInputPath,
			mappingId: input.mapping.id,
			outputNamespace: input.targetNamespace,
			outputPath: joinRootAndRelative(normalizedTargetRoot, relativePath),
			relativePath,
			rootId: match.root.id,
		},
	};
}
