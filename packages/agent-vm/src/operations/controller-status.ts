import type { SystemConfig } from '../config/system-config.js';

export type ControllerZoneLifecycleState = 'running' | 'failed' | 'stopped';

export interface ControllerRuntimeZoneStatus {
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
	readonly lastError?: string;
	readonly lifecycleState: ControllerZoneLifecycleState;
}

export interface ControllerRuntimeStatus {
	readonly activeLeases?: readonly { readonly zoneId: string }[];
	readonly zones?: Readonly<Record<string, ControllerRuntimeZoneStatus>>;
}

export interface ControllerZoneStatusSummary {
	readonly activeLeaseCount: number;
	readonly bootedAt?: string;
	readonly gatewayType: SystemConfig['zones'][number]['gateway']['type'];
	readonly id: string;
	readonly ingressHost?: string;
	readonly ingressPort: number;
	readonly lastError?: string;
	readonly lifecycleState: ControllerZoneLifecycleState;
	readonly running: boolean;
	readonly defaultToolVmProfile?: string;
	readonly vmId?: string;
}

export interface ControllerStatusSummary {
	readonly controllerPort: number;
	readonly toolVmProfiles: string[];
	readonly zones: ControllerZoneStatusSummary[];
}

function buildZoneStatus(
	zone: SystemConfig['zones'][number],
	runtimeStatus: ControllerRuntimeStatus,
): ControllerZoneStatusSummary {
	const zoneRuntimeStatus = runtimeStatus.zones?.[zone.id] ?? {
		lifecycleState: 'stopped' as const,
	};
	const running =
		zoneRuntimeStatus.lifecycleState === 'running' && zoneRuntimeStatus.gateway !== undefined;
	const activeLeaseCount =
		runtimeStatus.activeLeases?.filter((activeLease) => activeLease.zoneId === zone.id).length ?? 0;

	return {
		activeLeaseCount,
		gatewayType: zone.gateway.type,
		id: zone.id,
		ingressPort: running ? zoneRuntimeStatus.gateway.ingress.port : zone.gateway.port,
		lifecycleState: zoneRuntimeStatus.lifecycleState,
		running,
		...(running && zoneRuntimeStatus.bootedAt
			? {
					bootedAt: zoneRuntimeStatus.bootedAt,
				}
			: {}),
		...(running
			? {
					ingressHost: zoneRuntimeStatus.gateway.ingress.host,
					vmId: zoneRuntimeStatus.gateway.vm.id,
				}
			: {}),
		...(zoneRuntimeStatus.lastError ? { lastError: zoneRuntimeStatus.lastError } : {}),
		...(zone.defaultToolVmProfile ? { defaultToolVmProfile: zone.defaultToolVmProfile } : {}),
	};
}

export function buildControllerStatus(
	systemConfig: SystemConfig,
	runtimeStatus: ControllerRuntimeStatus = {},
): ControllerStatusSummary {
	return {
		controllerPort: systemConfig.host.controllerPort,
		toolVmProfiles: Object.keys(systemConfig.toolVmProfiles),
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
