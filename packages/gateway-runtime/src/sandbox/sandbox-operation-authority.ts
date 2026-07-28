import type { GatewayStablePrincipalDigest } from '@agent-vm/agent-portal-sdk/contracts';

export interface GatewayRuntimeSandboxOperationContext {
	readonly activeUseId: string;
	readonly environmentGeneration: string;
	readonly gatewayEpoch: string;
	readonly leafGeneration: string;
	readonly leaseId: string;
	readonly sshBindingId: string;
	readonly stablePrincipal: GatewayStablePrincipalDigest;
}

export type GatewayRuntimeSandboxOperationAuthorization =
	| { readonly kind: 'authorized' }
	| { readonly kind: 'stale-operation-authority' };

export interface GatewayRuntimeSandboxBoundHandle {
	readonly handleId: string;
	authorizeOperation(): GatewayRuntimeSandboxOperationAuthorization;
}

export interface GatewayRuntimeSandboxOperationAuthority {
	authorize(
		operationContext: GatewayRuntimeSandboxOperationContext,
	): GatewayRuntimeSandboxOperationAuthorization;
	beginReplacement(options: { readonly replacementLeafGeneration: string }): void;
	bindHandle(options: { readonly handleId: string }): GatewayRuntimeSandboxBoundHandle;
}

function contextsMatch(
	currentContext: GatewayRuntimeSandboxOperationContext,
	candidateContext: GatewayRuntimeSandboxOperationContext,
): boolean {
	return (
		candidateContext.activeUseId === currentContext.activeUseId &&
		candidateContext.environmentGeneration === currentContext.environmentGeneration &&
		candidateContext.gatewayEpoch === currentContext.gatewayEpoch &&
		candidateContext.leafGeneration === currentContext.leafGeneration &&
		candidateContext.leaseId === currentContext.leaseId &&
		candidateContext.sshBindingId === currentContext.sshBindingId &&
		candidateContext.stablePrincipal === currentContext.stablePrincipal
	);
}

export function createGatewayRuntimeSandboxOperationAuthority(
	currentContext: GatewayRuntimeSandboxOperationContext,
): GatewayRuntimeSandboxOperationAuthority {
	let replacementStarted = false;

	const authorize = (
		candidateContext: GatewayRuntimeSandboxOperationContext,
	): GatewayRuntimeSandboxOperationAuthorization =>
		replacementStarted || !contextsMatch(currentContext, candidateContext)
			? { kind: 'stale-operation-authority' }
			: { kind: 'authorized' };

	return {
		authorize,
		beginReplacement: () => {
			replacementStarted = true;
		},
		bindHandle: ({ handleId }) => ({
			authorizeOperation: () => authorize(currentContext),
			handleId,
		}),
	};
}
