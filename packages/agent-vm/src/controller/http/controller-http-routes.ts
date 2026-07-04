import type { SecretResolver } from '@agent-vm/secret-management';
import { Hono } from 'hono';

import {
	resolveControllerHealthConfig,
	type LoadedSystemConfig,
} from '../../config/system-config.js';
import { HealthEventStore } from '../health/health-event-store.js';
import {
	type AgentSandboxSeedResult,
	seedAgentSandboxWorkspace,
} from '../leases/agent-sandbox-seeding.js';
import {
	type ResolvedLeaseWorkMount,
	resolveLeaseWorkMountDir as resolveLeaseWorkMountDirForZone,
} from '../leases/lease-work-mount-paths.js';
import type { ObservedControllerLeaseCreateRequest } from '../leases/observed-lease-create-request.js';
import { OpenClawRuntimeStatusStore } from '../openclaw-runtime-status.js';
import { registerControllerHealthEventRoutes } from './controller-health-event-routes.js';
import {
	type ControllerLeaseManager,
	type ControllerRuntimeReadiness,
	type ControllerRouteOperations,
} from './controller-http-route-support.js';
import { registerControllerZoneOperationRoutes } from './controller-zone-operation-routes.js';

function writeControllerLeaseLog(message: string): void {
	process.stderr.write(`[controller-http-routes] ${message}\n`);
}

function logAgentSandboxSeedResult(result: AgentSandboxSeedResult): void {
	switch (result.kind) {
		case 'seeded':
			writeControllerLeaseLog(
				`seeded sandbox for zone '${result.zoneId}' agent '${result.agentId}' workMountDir '${result.hostWorkMountDir}': ${String(result.written)} written, ${String(result.alreadyExisted)} already existed`,
			);
			return;
		case 'malformed-agent-id':
			writeControllerLeaseLog(
				`skipped sandbox seeding for zone '${result.zoneId}' agent '${result.agentId}': ${result.reason}`,
			);
			return;
		case 'sandbox-root-missing':
			writeControllerLeaseLog(
				`skipped sandbox seeding for zone '${result.zoneId}' agent '${result.agentId}': sandbox root '${result.sandboxRoot}' does not exist`,
			);
			return;
		case 'work-mount-missing':
			writeControllerLeaseLog(
				`[WARN] skipped sandbox seeding for zone '${result.zoneId}' agent '${result.agentId}': work mount '${result.hostWorkMountDir}' does not exist`,
			);
			return;
		case 'work-mount-outside-sandbox':
			writeControllerLeaseLog(
				`[WARN] skipped sandbox seeding for zone '${result.zoneId}' agent '${result.agentId}': work mount '${result.hostWorkMountDir}' is outside sandbox root '${result.sandboxRoot}'`,
			);
			return;
		case 'no-seeds-configured':
		case 'not-openclaw-zone':
			return;
	}
}

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
	readonly openClawRuntimeStatusStore?: OpenClawRuntimeStatusStore;
	readonly now?: () => number;
	readonly onLeaseCreateRequest?: (request: ObservedControllerLeaseCreateRequest) => void;
	readonly operations?: Partial<ControllerRouteOperations>;
	readonly validateToolVmLeaseRequirements?: (zoneId: string) => Promise<void>;
	readonly resolveLeaseWorkMountDir: (options: {
		readonly agentId: string;
		readonly workMountDir: string;
		readonly zoneId: string;
	}) => Promise<ResolvedLeaseWorkMount>;
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
	readonly openClawRuntimeStatusStore?: OpenClawRuntimeStatusStore;
	readonly operations?: Partial<ControllerRouteOperations>;
	readonly readIdentityPem?: (identityFilePath: string) => Promise<string>;
	readonly runtimeReadiness?: () => ControllerRuntimeReadiness;
	readonly secretResolver?: SecretResolver;
	readonly systemConfig: LoadedSystemConfig;
}): Hono {
	const zonesById = new Map(options.systemConfig.zones.map((zone) => [zone.id, zone]));
	const openClawRuntimeStatusStore =
		options.openClawRuntimeStatusStore ?? new OpenClawRuntimeStatusStore();
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
		openClawRuntimeStatusStore,
		...(options.operations ? { operations: options.operations } : {}),
		validateToolVmLeaseRequirements: async (zoneId) => {
			const zone = zonesById.get(zoneId);
			if (!zone || zone.gateway.type !== 'openclaw') {
				return;
			}
			openClawRuntimeStatusStore.assertFreshOk(zoneId);
		},
		resolveLeaseWorkMountDir: async ({ agentId, workMountDir, zoneId }) => {
			const zone = zonesById.get(zoneId);
			if (!zone) {
				throw new Error(`Unknown zone '${zoneId}'`);
			}
			const resolvedWorkMount = await resolveLeaseWorkMountDirForZone({
				agentId,
				runtimeDir: options.systemConfig.runtimeDir,
				workMountDir,
				zone,
			});
			if (options.secretResolver) {
				const seedResult = await seedAgentSandboxWorkspace({
					agentId,
					secretResolver: options.secretResolver,
					hostWorkMountDir: resolvedWorkMount.hostWorkMountDir,
					zone,
				});
				logAgentSandboxSeedResult(seedResult);
			}
			return resolvedWorkMount;
		},
	});

	return app;
}
