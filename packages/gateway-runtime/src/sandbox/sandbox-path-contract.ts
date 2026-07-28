import path from 'node:path';

export interface GatewayRuntimeSandboxTraversalLimits {
	readonly maxBytes: number;
	readonly maxDepth: number;
	readonly maxElapsedMs: number;
	readonly maxEntries: number;
	readonly maxSymlinkDepth: number;
}

export interface GatewayRuntimeSandboxTraversalObservation {
	readonly bytesRead: number;
	readonly depth: number;
	readonly elapsedMs: number;
	readonly entriesVisited: number;
	readonly symlinkDepth: number;
}

type GatewayRuntimeSandboxPathRejectionReason =
	| 'path-must-be-work-relative'
	| 'path-contains-nul'
	| 'path-traverses-parent';

type GatewayRuntimeSandboxTraversalRejectionReason =
	| 'entry-cap-exceeded'
	| 'depth-cap-exceeded'
	| 'byte-cap-exceeded'
	| 'time-cap-exceeded'
	| 'symlink-cap-exceeded';

export type GatewayRuntimeSandboxPathResolution =
	| {
			readonly guestPath: string;
			readonly kind: 'resolved';
			readonly relativePath: string;
	  }
	| { readonly kind: 'rejected'; readonly reason: GatewayRuntimeSandboxPathRejectionReason };

export type GatewayRuntimeSandboxTraversalAuthorization =
	| { readonly kind: 'authorized' }
	| { readonly kind: 'rejected'; readonly reason: GatewayRuntimeSandboxTraversalRejectionReason };

export interface GatewayRuntimeSandboxPathContract {
	authorizeTraversal(
		observation: GatewayRuntimeSandboxTraversalObservation,
	): GatewayRuntimeSandboxTraversalAuthorization;
	resolve(requestedPath: string): GatewayRuntimeSandboxPathResolution;
}

export const DEFAULT_GATEWAY_RUNTIME_SANDBOX_TRAVERSAL_LIMITS = {
	maxBytes: 1_048_576,
	maxDepth: 16,
	maxElapsedMs: 5_000,
	maxEntries: 100,
	maxSymlinkDepth: 8,
} as const satisfies GatewayRuntimeSandboxTraversalLimits;

export function createGatewayRuntimeSandboxPathContract(options: {
	readonly guestWorkRoot: '/work';
	readonly limits: GatewayRuntimeSandboxTraversalLimits;
}): GatewayRuntimeSandboxPathContract {
	return {
		authorizeTraversal: (observation) => {
			if (observation.entriesVisited > options.limits.maxEntries) {
				return { kind: 'rejected', reason: 'entry-cap-exceeded' };
			}
			if (observation.depth > options.limits.maxDepth) {
				return { kind: 'rejected', reason: 'depth-cap-exceeded' };
			}
			if (observation.bytesRead > options.limits.maxBytes) {
				return { kind: 'rejected', reason: 'byte-cap-exceeded' };
			}
			if (observation.elapsedMs > options.limits.maxElapsedMs) {
				return { kind: 'rejected', reason: 'time-cap-exceeded' };
			}
			if (observation.symlinkDepth > options.limits.maxSymlinkDepth) {
				return { kind: 'rejected', reason: 'symlink-cap-exceeded' };
			}
			return { kind: 'authorized' };
		},
		resolve: (requestedPath) => {
			if (requestedPath.includes('\0')) {
				return { kind: 'rejected', reason: 'path-contains-nul' };
			}
			if (path.posix.isAbsolute(requestedPath)) {
				return { kind: 'rejected', reason: 'path-must-be-work-relative' };
			}
			if (requestedPath.split('/').includes('..')) {
				return { kind: 'rejected', reason: 'path-traverses-parent' };
			}
			const normalizedRelativePath = path.posix.normalize(requestedPath);
			return {
				guestPath: path.posix.join(options.guestWorkRoot, normalizedRelativePath),
				kind: 'resolved',
				relativePath: normalizedRelativePath === '.' ? '' : normalizedRelativePath,
			};
		},
	};
}
