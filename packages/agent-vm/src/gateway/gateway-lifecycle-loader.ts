import type { GatewayLifecycle, GatewayZoneConfig } from 'gateway-interface';
import { openclawLifecycle } from 'openclaw-gateway';
import { workerLifecycle } from 'worker-gateway';

const lifecycleByType = {
	coding: workerLifecycle,
	openclaw: openclawLifecycle,
} satisfies Record<string, GatewayLifecycle>;

export function loadGatewayLifecycle(type: GatewayZoneConfig['gateway']['type']): GatewayLifecycle {
	return lifecycleByType[type];
}
