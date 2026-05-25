export const TOOL_VM_WORKSPACE_GUEST_ROOT = '/workspace';
export const TOOL_VM_SCRATCH_GUEST_ROOT = '/work';

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

export interface RuntimePathRootMapping {
	readonly backing: RuntimePathBacking;
	readonly capabilities: RuntimePathCapabilities;
	readonly guestRoot?: string;
	readonly guidanceLabel: string;
	readonly hostRoot?: string;
	readonly id: string;
	readonly rootPathAllowed: boolean;
}

export interface RuntimePathMapping {
	readonly id: string;
	readonly roots: readonly RuntimePathRootMapping[];
}

export interface TranslateRuntimePathInput {
	readonly inputPath: string;
	readonly mapping: RuntimePathMapping;
	readonly purpose: RuntimePathPurpose;
}

export interface RuntimePathTranslation {
	readonly backing: RuntimePathBacking;
	readonly capabilities: RuntimePathCapabilities;
	readonly guestPath?: string;
	readonly guestRoot?: string;
	readonly hasHostBacking: boolean;
	readonly hostPath?: string;
	readonly hostRoot?: string;
	readonly inputNamespace: 'guest' | 'host';
	readonly inputPath: string;
	readonly mappingId: string;
	readonly relativePath: string;
	readonly rootId: string;
}

export type RuntimePathTranslationErrorCode =
	| 'path-not-absolute'
	| 'path-parent-traversal'
	| 'unknown-runtime-path'
	| 'purpose-not-allowed'
	| 'root-path-not-allowed';

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
	readonly inputNamespace: 'guest' | 'host';
	readonly matchedRoot: string;
	readonly root: RuntimePathRootMapping;
}

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

function allowedPathFormsForMapping(
	mapping: RuntimePathMapping,
	purpose: RuntimePathPurpose,
): readonly string[] {
	return mapping.roots.flatMap((root) => {
		if (!root.capabilities[purpose]) {
			return [];
		}
		const suffix = root.rootPathAllowed ? '[/subpath]' : '/<child>';
		return [root.guestRoot, root.hostRoot]
			.filter((value): value is string => value !== undefined)
			.map((value) => `${normalizeRoot(value)}${suffix}`);
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
}): RuntimePathRootMatch | undefined {
	const matches = params.mapping.roots.flatMap((root): RuntimePathRootMatch[] => {
		const guestRoot = root.guestRoot === undefined ? undefined : normalizeRoot(root.guestRoot);
		const hostRoot = root.hostRoot === undefined ? undefined : normalizeRoot(root.hostRoot);
		const rootMatches: RuntimePathRootMatch[] = [];
		if (guestRoot !== undefined && pathMatchesRoot(params.inputPath, guestRoot)) {
			rootMatches.push({ inputNamespace: 'guest', matchedRoot: guestRoot, root });
		}
		if (hostRoot !== undefined && pathMatchesRoot(params.inputPath, hostRoot)) {
			rootMatches.push({ inputNamespace: 'host', matchedRoot: hostRoot, root });
		}
		return rootMatches;
	});
	return matches.toSorted((left, right) => right.matchedRoot.length - left.matchedRoot.length)[0];
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
	const normalizedInputPath = normalizeAbsolutePath(input.inputPath);
	const match = findBestRootMatch({
		inputPath: normalizedInputPath,
		mapping: input.mapping,
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
	const guestRoot =
		match.root.guestRoot === undefined ? undefined : normalizeRoot(match.root.guestRoot);
	const hostRoot =
		match.root.hostRoot === undefined ? undefined : normalizeRoot(match.root.hostRoot);
	return {
		ok: true,
		value: {
			backing: match.root.backing,
			capabilities: match.root.capabilities,
			...(guestRoot !== undefined
				? { guestPath: joinRootAndRelative(guestRoot, relativePath) }
				: {}),
			...(guestRoot !== undefined ? { guestRoot } : {}),
			hasHostBacking: hostRoot !== undefined,
			...(hostRoot !== undefined ? { hostPath: joinRootAndRelative(hostRoot, relativePath) } : {}),
			...(hostRoot !== undefined ? { hostRoot } : {}),
			inputNamespace: match.inputNamespace,
			inputPath: normalizedInputPath,
			mappingId: input.mapping.id,
			relativePath,
			rootId: match.root.id,
		},
	};
}
