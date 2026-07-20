import type { GatewayLifecycle, GatewayZoneConfig } from '@agent-vm/gateway-lifecycle';
import { hermesLifecycle } from '@agent-vm/hermes-gateway';
import { openclawLifecycle } from '@agent-vm/openclaw-gateway';
import { workerLifecycle } from '@agent-vm/worker-gateway';

const lifecycleByType = {
	openclaw: openclawLifecycle,
	hermes: hermesLifecycle,
	worker: workerLifecycle,
} satisfies Record<GatewayZoneConfig['gateway']['type'], GatewayLifecycle>;

export function loadGatewayLifecycle<TGatewayType extends GatewayZoneConfig['gateway']['type']>(
	type: TGatewayType,
): (typeof lifecycleByType)[TGatewayType] {
	return lifecycleByType[type];
}
