import type { SystemConfig } from '../controller/system-config.js';

export interface ControllerStatusSummary {
	readonly controllerPort: number;
	readonly toolProfiles: string[];
	readonly zones: {
		readonly id: string;
		readonly ingressPort: number;
		readonly toolProfile: string;
	}[];
}

export function buildControllerStatus(systemConfig: SystemConfig): ControllerStatusSummary {
	return {
		controllerPort: systemConfig.host.controllerPort,
		toolProfiles: Object.keys(systemConfig.toolProfiles),
		zones: systemConfig.zones.map((zone) => ({
			id: zone.id,
			ingressPort: zone.gateway.port,
			toolProfile: zone.toolProfile,
		})),
	};
}
