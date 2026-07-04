import { createHash } from 'node:crypto';

export type GatewayControlCallerContextCachePurpose =
	| 'tool_portal_controller_host_action'
	| 'tool_vm_lease';

export interface GatewayControlCallerContextCacheScope {
	readonly agentId: string;
	readonly agentWorkspaceDir: string;
	readonly purpose: GatewayControlCallerContextCachePurpose;
	readonly sessionKey: string;
	readonly workMountDir: string;
	readonly zoneId: string;
}

export interface GatewayControlCallerContextStore {
	forgetCallerContextForAgent(options: GatewayControlCallerContextCacheScope): void;
	rememberCallerContextForAgent(
		options: {
			readonly callerContextId: string;
		} & GatewayControlCallerContextCacheScope,
	): void;
	resolveCallerContextIdForAgent(
		options: GatewayControlCallerContextCacheScope,
	): string | undefined;
}

function digestGatewayControlCallerContextSessionKey(sessionKey: string): string {
	return createHash('sha256').update(sessionKey, 'utf8').digest('base64url');
}

export function cacheKeyForGatewayControlCallerContext(
	options: GatewayControlCallerContextCacheScope,
): string {
	return [
		options.zoneId,
		options.purpose,
		options.agentId,
		options.agentWorkspaceDir,
		options.workMountDir,
		digestGatewayControlCallerContextSessionKey(options.sessionKey),
	].join('\u0000');
}

export function createGatewayControlCallerContextStore(): GatewayControlCallerContextStore {
	const callerContextIdByCacheKey = new Map<string, string>();
	return {
		forgetCallerContextForAgent: (options) => {
			callerContextIdByCacheKey.delete(cacheKeyForGatewayControlCallerContext(options));
		},
		rememberCallerContextForAgent: ({ callerContextId, ...scope }) => {
			callerContextIdByCacheKey.set(cacheKeyForGatewayControlCallerContext(scope), callerContextId);
		},
		resolveCallerContextIdForAgent: (options) =>
			callerContextIdByCacheKey.get(cacheKeyForGatewayControlCallerContext(options)),
	};
}
