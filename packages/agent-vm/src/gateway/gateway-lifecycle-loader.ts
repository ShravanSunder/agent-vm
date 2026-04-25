import type { GatewayLifecycle, GatewayZoneConfig } from '@agent-vm/gateway-interface';
import { openclawLifecycle } from '@agent-vm/openclaw-gateway';
import { workerLifecycle } from '@agent-vm/worker-gateway';

const lifecycleByType = {
	worker: workerLifecycle,
	openclaw: openclawLifecycle,
} satisfies Record<string, GatewayLifecycle>;

export function loadGatewayLifecycle(type: GatewayZoneConfig['gateway']['type']): GatewayLifecycle {
	return lifecycleByType[type];
}
