import type { SystemConfig } from '../config/system-config.js';

export interface ControllerRuntimeStatus {
	readonly activeLeases?: readonly { readonly zoneId: string }[];
	readonly activeZoneId?: string;
	readonly bootedAt?: string;
	readonly gateway?: {
		readonly ingress: {
			readonly host: string;
			readonly port: number;
		};
		readonly vm: {
			readonly id: string;
		};
	};
	readonly lastErrorByZone?: Readonly<Record<string, string>>;
}

export interface ControllerZoneStatusSummary {
	readonly activeLeaseCount: number;
	readonly bootedAt?: string;
	readonly gatewayType: SystemConfig['zones'][number]['gateway']['type'];
	readonly id: string;
	readonly ingressHost?: string;
	readonly ingressPort: number;
	readonly lastError?: string;
	readonly running: boolean;
	readonly toolProfile?: string;
	readonly vmId?: string;
}

export interface ControllerStatusSummary {
	readonly controllerPort: number;
	readonly toolProfiles: string[];
	readonly zones: ControllerZoneStatusSummary[];
}

function buildZoneStatus(
	zone: SystemConfig['zones'][number],
	runtimeStatus: ControllerRuntimeStatus,
): ControllerZoneStatusSummary {
	const running = runtimeStatus.activeZoneId === zone.id && runtimeStatus.gateway !== undefined;
	const activeLeaseCount =
		runtimeStatus.activeLeases?.filter((activeLease) => activeLease.zoneId === zone.id).length ?? 0;
	const lastError = runtimeStatus.lastErrorByZone?.[zone.id];

	return {
		activeLeaseCount,
		gatewayType: zone.gateway.type,
		id: zone.id,
		ingressPort: running ? runtimeStatus.gateway.ingress.port : zone.gateway.port,
		running,
		...(running && runtimeStatus.bootedAt
			? {
					bootedAt: runtimeStatus.bootedAt,
				}
			: {}),
		...(running
			? {
					ingressHost: runtimeStatus.gateway.ingress.host,
					vmId: runtimeStatus.gateway.vm.id,
				}
			: {}),
		...(lastError ? { lastError } : {}),
		...(zone.toolProfile ? { toolProfile: zone.toolProfile } : {}),
	};
}

export function buildControllerStatus(
	systemConfig: SystemConfig,
	runtimeStatus: ControllerRuntimeStatus = {},
): ControllerStatusSummary {
	return {
		controllerPort: systemConfig.host.controllerPort,
		toolProfiles: Object.keys(systemConfig.toolProfiles),
		zones: systemConfig.zones.map((zone) => buildZoneStatus(zone, runtimeStatus)),
	};
}

export function buildControllerZoneStatus(
	systemConfig: SystemConfig,
	zoneId: string,
	runtimeStatus: ControllerRuntimeStatus = {},
): ControllerZoneStatusSummary {
	const zone = systemConfig.zones.find((configuredZone) => configuredZone.id === zoneId);
	if (!zone) {
		throw new Error(`Unknown zone '${zoneId}'.`);
	}
	return buildZoneStatus(zone, runtimeStatus);
}
