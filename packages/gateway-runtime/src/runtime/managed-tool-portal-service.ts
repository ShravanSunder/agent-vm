import type { ToolPortalCapabilityCore, ToolPortalService } from '@agent-vm/tool-portal';

export interface GatewayRuntimeManagedToolPortalService<
	TOwnedComponents,
> extends ToolPortalService<'managed'> {
	readonly ownedComponents: TOwnedComponents;
}

export function createGatewayRuntimeManagedToolPortalService<TOwnedComponents>(props: {
	readonly capabilityCore: ToolPortalCapabilityCore<'managed'>;
	readonly ownedComponents: TOwnedComponents;
}): GatewayRuntimeManagedToolPortalService<TOwnedComponents> {
	return Object.freeze({
		capabilityCore: props.capabilityCore,
		mode: 'managed',
		ownedComponents: props.ownedComponents,
	});
}
