import type { GatewayZoneConfig } from '@agent-vm/gateway-contracts';
import type { GondolinGatewayLifecycle } from '@agent-vm/gondolin-gateway-types';
import { openclawLifecycle } from '@agent-vm/openclaw-gateway';
import { workerLifecycle } from '@agent-vm/worker-gateway';

const lifecycleByType = {
	worker: workerLifecycle,
	openclaw: openclawLifecycle,
} satisfies Record<string, GondolinGatewayLifecycle>;

export function loadGatewayLifecycle(
	type: GatewayZoneConfig['gateway']['type'],
): GondolinGatewayLifecycle {
	return lifecycleByType[type];
}
