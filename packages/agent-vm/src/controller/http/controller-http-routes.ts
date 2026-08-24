import { Hono } from 'hono';

import {
	resolveControllerHealthConfig,
	type LoadedSystemConfig,
} from '../../config/system-config.js';
import { HealthEventStore } from '../health/health-event-store.js';
import type { ObservedControllerLeaseCreateRequest } from '../leases/observed-lease-create-request.js';
import { registerControllerHealthEventRoutes } from './controller-health-event-routes.js';
import {
	type ControllerLeaseManager,
	type ControllerRuntimeReadiness,
	type ControllerRouteOperations,
} from './controller-http-route-support.js';
import { registerControllerZoneOperationRoutes } from './controller-zone-operation-routes.js';

const defaultHealthEventHistoryLimit = 500;
const defaultHealthEventStaleAfterMs = 30_000;

export function createControllerApp(options: {
	readonly controllerPort?: number;
	readonly leaseManager: ControllerLeaseManager;
	readonly readIdentityPem?: (identityFilePath: string) => Promise<string>;
	readonly runtimeReadiness?: () => ControllerRuntimeReadiness;
	readonly toolVmProfiles?: Record<
		string,
		{
			readonly cpus: number;
			readonly imageProfile: string;
			readonly memory: string;
			readonly runtimeRootfsSize?: string | undefined;
		}
	>;
	readonly zoneAgentToolVmProfiles?: Record<string, Record<string, string>>;
	readonly zoneDefaultToolVmProfiles?: Record<string, string>;
	readonly zoneIds?: ReadonlySet<string>;
	readonly healthEventStore?: HealthEventStore;
	readonly now?: () => number;
	readonly onLeaseCreateRequest?: (request: ObservedControllerLeaseCreateRequest) => void;
	readonly operations?: Partial<ControllerRouteOperations>;
}): Hono {
	const app = new Hono();
	const healthEventStore =
		options.healthEventStore ??
		new HealthEventStore({
			eventHistoryLimit: defaultHealthEventHistoryLimit,
			staleAfterMs: defaultHealthEventStaleAfterMs,
		});
	const now = options.now ?? Date.now;
	const getRuntimeReadiness = (): ControllerRuntimeReadiness =>
		options.runtimeReadiness?.() ?? { ready: true, state: 'ready' };

	app.get('/health', (context) => {
		const readiness = getRuntimeReadiness();
		return context.json(
			{
				ok: readiness.ready,
				...(options.controllerPort !== undefined ? { port: options.controllerPort } : {}),
				state: readiness.state,
			},
			readiness.ready ? 200 : 503,
		);
	});

	registerControllerHealthEventRoutes(app, {
		now,
		store: healthEventStore,
		...(options.zoneIds ? { zoneIds: options.zoneIds } : {}),
	});

	if (options.operations) {
		const defaultOperations: ControllerRouteOperations = {
			destroyZone: async () => {
				throw new Error('destroy-zone-unavailable');
			},
			getStatus: async () => ({}),
			getZoneLogs: async () => {
				throw new Error('zone-logs-unavailable');
			},
			getZoneStatus: async () => {
				throw new Error('zone-status-unavailable');
			},
			refreshZoneCredentials: async () => {
				throw new Error('refresh-zone-credentials-unavailable');
			},
			upgradeZone: async () => {
				throw new Error('upgrade-zone-unavailable');
			},
		};
		registerControllerZoneOperationRoutes(
			app,
			{
				...defaultOperations,
				...options.operations,
			},
			{
				healthEventStore,
				now,
				runtimeReadiness: getRuntimeReadiness,
			},
		);
	}

	return app;
}

export function createControllerService(options: {
	readonly healthEventStore?: HealthEventStore;
	readonly leaseManager: ControllerLeaseManager;
	readonly now?: () => number;
	readonly onLeaseCreateRequest?: (request: ObservedControllerLeaseCreateRequest) => void;
	readonly operations?: Partial<ControllerRouteOperations>;
	readonly readIdentityPem?: (identityFilePath: string) => Promise<string>;
	readonly runtimeReadiness?: () => ControllerRuntimeReadiness;
	readonly systemConfig: LoadedSystemConfig;
}): Hono {
	const controllerHealthConfig = resolveControllerHealthConfig(options.systemConfig);
	const app = createControllerApp({
		controllerPort: options.systemConfig.host.controllerPort,
		healthEventStore:
			options.healthEventStore ??
			new HealthEventStore({
				eventHistoryLimit: controllerHealthConfig.eventHistoryLimit,
				staleAfterMs: controllerHealthConfig.staleAfterMs,
			}),
		leaseManager: options.leaseManager,
		...(options.now ? { now: options.now } : {}),
		...(options.onLeaseCreateRequest ? { onLeaseCreateRequest: options.onLeaseCreateRequest } : {}),
		...(options.readIdentityPem ? { readIdentityPem: options.readIdentityPem } : {}),
		...(options.runtimeReadiness ? { runtimeReadiness: options.runtimeReadiness } : {}),
		toolVmProfiles: options.systemConfig.toolVmProfiles,
		zoneIds: new Set(options.systemConfig.zones.map((zone) => zone.id)),
		zoneDefaultToolVmProfiles: Object.fromEntries(
			options.systemConfig.zones.flatMap((zone) =>
				zone.defaultToolVmProfile === undefined ? [] : [[zone.id, zone.defaultToolVmProfile]],
			),
		),
		zoneAgentToolVmProfiles: Object.fromEntries(
			options.systemConfig.zones.flatMap((zone) =>
				!zone.agentToolVmProfiles || Object.keys(zone.agentToolVmProfiles).length === 0
					? []
					: [[zone.id, zone.agentToolVmProfiles]],
			),
		),
		...(options.operations ? { operations: options.operations } : {}),
	});

	return app;
}
