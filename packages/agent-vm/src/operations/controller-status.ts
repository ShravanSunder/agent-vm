import type { SystemConfig } from '../config/system-config.js';
import type { HealthEventEvidenceDiagnostics } from '../controller/health/health-event-store.js';
import type {
	GatewayDiagnosisSnapshot,
	GatewayLifecycleErrorCode,
	GatewaySelectedZoneReadiness,
	GatewayToolVmLeaseState,
} from '../controller/zone-runtimes/gateway-zone-state-machine.js';
import type { ControllerTelemetryDiagnostics } from '../observability/controller-telemetry.js';

export type ControllerZoneLifecycleState = 'running' | 'failed' | 'stopped';
export type ControllerZoneDiagnosisStatus = Readonly<GatewayDiagnosisSnapshot>;

export interface ControllerRuntimeZoneStatus {
	readonly bootedAt?: string;
	readonly gateway?: {
		readonly ingress: {
			readonly host: string;
			readonly port: number;
		};
		readonly vm: {
			readonly hostPid?: number;
			readonly id: string;
		};
	};
	readonly lastError?: string;
	readonly lifecycleState: ControllerZoneLifecycleState;
}

export interface ControllerRuntimeStatus {
	readonly activeLeases?: readonly { readonly zoneId: string }[];
	readonly diagnoses?: Readonly<Record<string, ControllerZoneDiagnosisStatus>>;
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
	readonly diagnosis: ControllerZoneDiagnosisStatus;
	readonly readiness: GatewaySelectedZoneReadiness;
	readonly running: boolean;
	readonly toolVmLeaseState: GatewayToolVmLeaseState;
	readonly defaultToolVmProfile?: string;
	readonly vmId?: string;
}

export interface ControllerStatusSummary {
	readonly controllerPort: number;
	readonly observability?: ControllerObservabilityStatus | undefined;
	readonly toolVmProfiles: string[];
	readonly zones: ControllerZoneStatusSummary[];
}

export interface ControllerObservabilityStatus {
	readonly evidence: HealthEventEvidenceDiagnostics;
	readonly telemetry?: ControllerTelemetryDiagnostics | undefined;
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
	const diagnosis =
		runtimeStatus.diagnoses?.[zone.id] ?? deriveFallbackDiagnosis(zoneRuntimeStatus, running);
	const activeLeaseCount =
		runtimeStatus.activeLeases?.filter((activeLease) => activeLease.zoneId === zone.id).length ?? 0;

	return {
		activeLeaseCount,
		gatewayType: zone.gateway.type,
		id: zone.id,
		ingressPort: running ? zoneRuntimeStatus.gateway.ingress.port : zone.gateway.port,
		lifecycleState: zoneRuntimeStatus.lifecycleState,
		diagnosis,
		readiness: diagnosis.selectedZoneReadiness,
		running,
		toolVmLeaseState: diagnosis.toolVmLeaseState,
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

function deriveFallbackDiagnosis(
	zoneRuntimeStatus: ControllerRuntimeZoneStatus,
	running: boolean,
): ControllerZoneDiagnosisStatus {
	const currentRecoveryBlocker = classifyStatusRecoveryBlocker(zoneRuntimeStatus.lastError);
	const selectedZoneReadiness =
		running && currentRecoveryBlocker === 'none' ? 'running' : running ? 'degraded' : 'failed';
	return {
		channelProviderPlane: 'unknown',
		controllerLiveness: 'ok',
		currentRecoveryBlocker,
		gatewayInfrastructure: zoneRuntimeStatus.lifecycleState,
		lastOperation: 'none',
		originalOutageCause: { kind: 'unknown' },
		selectedZoneReadiness,
		toolVmLeaseState: 'not-applicable',
		toolVmPlane: 'unknown',
	};
}

function classifyStatusRecoveryBlocker(
	lastError: string | undefined,
): GatewayLifecycleErrorCode | 'none' {
	if (!lastError) {
		return 'none';
	}
	const normalizedError = lastError.toLowerCase();
	if (
		normalizedError.includes('secret') ||
		normalizedError.includes('resolveall') ||
		normalizedError.includes('op failed') ||
		normalizedError.includes('1password')
	) {
		return 'secret-resolution-failed';
	}
	if (normalizedError.includes('owner') || normalizedError.includes('unsafe')) {
		return 'owner-unsafe';
	}
	if (normalizedError.includes('readyz') || normalizedError.includes('readiness')) {
		return 'readiness-failed';
	}
	if (normalizedError.includes('stale-generation-closed')) {
		return 'stale-generation-closed';
	}
	if (normalizedError.includes('vm-process-missing')) {
		return 'vm-process-missing';
	}
	return 'vm-start-failed';
}

export function buildControllerStatus(
	systemConfig: SystemConfig,
	runtimeStatus: ControllerRuntimeStatus = {},
	observabilityStatus?: ControllerObservabilityStatus,
): ControllerStatusSummary {
	return {
		controllerPort: systemConfig.host.controllerPort,
		...(observabilityStatus === undefined ? {} : { observability: observabilityStatus }),
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
