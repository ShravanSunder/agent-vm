import type { GatewayRuntimeTrustedInvocationContext } from '@agent-vm/gateway-control-contracts';

export interface ManagedEngineInvocationContext {
	readonly signal?: AbortSignal;
	readonly surfaceClass: 'mcp' | 'protected_uds';
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
}
