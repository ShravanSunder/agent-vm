import type { GatewayLifecycle, GatewayZoneConfig } from '@shravansunder/gateway-interface';
import { openclawLifecycle } from '@shravansunder/openclaw-gateway';
import { workerLifecycle } from '@shravansunder/worker-gateway';

const lifecycleByType = {
	worker: workerLifecycle,
	openclaw: openclawLifecycle,
} satisfies Record<string, GatewayLifecycle>;

export function loadGatewayLifecycle(type: GatewayZoneConfig['gateway']['type']): GatewayLifecycle {
	return lifecycleByType[type];
}
