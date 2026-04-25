import type { SystemConfig } from '../config/system-config.js';

export interface ControllerStatusSummary {
	readonly controllerPort: number;
	readonly toolProfiles: string[];
	readonly zones: {
		readonly gatewayType: SystemConfig['zones'][number]['gateway']['type'];
		readonly id: string;
		readonly ingressPort: number;
		readonly toolProfile?: string;
	}[];
}

export function buildControllerStatus(systemConfig: SystemConfig): ControllerStatusSummary {
	return {
		controllerPort: systemConfig.host.controllerPort,
		toolProfiles: Object.keys(systemConfig.toolProfiles),
		zones: systemConfig.zones.map((zone) => ({
			gatewayType: zone.gateway.type,
			id: zone.id,
			ingressPort: zone.gateway.port,
			...(zone.toolProfile ? { toolProfile: zone.toolProfile } : {}),
		})),
	};
}
