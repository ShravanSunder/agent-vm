import type { ToolPortalCapabilityCore } from '@agent-vm/gateway-runtime/managed-tool-engine/models/managed-portal-ports.js';

export interface GatewayRuntimeManagedToolPortalService<TOwnedComponents> {
	readonly mode: 'managed';
	readonly capabilityCore: ToolPortalCapabilityCore;
	readonly ownedComponents: TOwnedComponents;
}

export function createGatewayRuntimeManagedToolPortalService<TOwnedComponents>(props: {
	readonly capabilityCore: ToolPortalCapabilityCore;
	readonly ownedComponents: TOwnedComponents;
}): GatewayRuntimeManagedToolPortalService<TOwnedComponents> {
	return Object.freeze({
		capabilityCore: props.capabilityCore,
		mode: 'managed',
		ownedComponents: props.ownedComponents,
	});
}
