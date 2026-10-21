import type { GatewayRuntimeTrustedInvocationContext } from '@agent-vm/gateway-control-contracts';

export interface ManagedEngineInvocationContext {
	readonly surfaceClass: 'mcp' | 'protected_uds';
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
}
