import type {
	GatewayLifecycle,
	GatewayZoneConfig,
} from '@shravansunder/agent-vm-gateway-interface';
import { openclawLifecycle } from '@shravansunder/agent-vm-openclaw-gateway';
import { workerLifecycle } from '@shravansunder/agent-vm-worker-gateway';

const lifecycleByType = {
	coding: workerLifecycle,
	openclaw: openclawLifecycle,
} satisfies Record<string, GatewayLifecycle>;

export function loadGatewayLifecycle(type: GatewayZoneConfig['gateway']['type']): GatewayLifecycle {
	return lifecycleByType[type];
}
