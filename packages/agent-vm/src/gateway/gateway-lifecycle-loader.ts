import type { GatewayLifecycle, GatewayZoneConfig } from '@agent-vm/gateway-lifecycle';
import { hermesLifecycle } from '@agent-vm/hermes-gateway';
import { workerLifecycle } from '@agent-vm/worker-gateway';

const lifecycleByType = {
	hermes: hermesLifecycle,
	worker: workerLifecycle,
} satisfies Record<GatewayZoneConfig['gateway']['type'], GatewayLifecycle>;

export function loadGatewayLifecycle<TGatewayType extends GatewayZoneConfig['gateway']['type']>(
	type: TGatewayType,
): (typeof lifecycleByType)[TGatewayType] {
	return lifecycleByType[type];
}
