import type { SecretResolver } from '@agent-vm/gondolin-adapter';
import { Hono } from 'hono';

import type { SystemConfig } from '../../config/system-config.js';
import {
	type AgentSandboxSeedResult,
	seedAgentSandboxWorkspace,
} from '../leases/agent-sandbox-seeding.js';
import { LeaseScopeConflictError } from '../leases/lease-manager.js';
import { parseAgentIdFromScopeKey } from '../leases/lease-scope.js';
import {
	LeaseWorkspaceValidationError,
	resolveLeaseWorkspaceDir as resolveLeaseWorkspaceDirForZone,
} from '../leases/lease-workspace-paths.js';
import {
	type ControllerLeaseManager,
	type ControllerRouteOperations,
	readIdentityPemFromFile,
	serializeLeasePeekForResponse,
	serializeLeaseForResponse,
} from './controller-http-route-support.js';
import { controllerLeaseCreateRequestSchema } from './controller-request-schemas.js';
import { registerControllerZoneOperationRoutes } from './controller-zone-operation-routes.js';

function writeControllerLeaseLog(message: string): void {
	process.stderr.write(`[controller-http-routes] ${message}\n`);
}

function logAgentSandboxSeedResult(result: AgentSandboxSeedResult): void {
	switch (result.kind) {
		case 'seeded':
			writeControllerLeaseLog(
				`seeded sandbox for zone '${result.zoneId}' scope '${result.scopeKey}' agent '${result.agentId}': ${String(result.written)} written, ${String(result.alreadyExisted)} already existed`,
			);
			return;
		case 'malformed-agent-scope':
			writeControllerLeaseLog(
				`skipped sandbox seeding for zone '${result.zoneId}' scope '${result.scopeKey}': ${result.reason}`,
			);
			return;
		case 'sandbox-root-missing':
			writeControllerLeaseLog(
				`skipped sandbox seeding for zone '${result.zoneId}' scope '${result.scopeKey}': sandbox root '${result.sandboxRoot}' does not exist`,
			);
			return;
		case 'workspace-missing':
			writeControllerLeaseLog(
				`skipped sandbox seeding for zone '${result.zoneId}' scope '${result.scopeKey}': workspace '${result.workspaceDir}' does not exist`,
			);
			return;
		case 'workspace-outside-sandbox':
			writeControllerLeaseLog(
				`skipped sandbox seeding for zone '${result.zoneId}' scope '${result.scopeKey}': workspace '${result.workspaceDir}' is outside sandbox root '${result.sandboxRoot}'`,
			);
			return;
		case 'no-seeds-configured':
		case 'non-agent-scope':
		case 'not-openclaw-zone':
			return;
	}
}

export function createControllerApp(options: {
	readonly leaseManager: ControllerLeaseManager;
	readonly readIdentityPem?: (identityFilePath: string) => Promise<string>;
	readonly toolVmProfiles?: Record<
		string,
		{
			readonly cpus: number;
			readonly imageProfile: string;
			readonly memory: string;
		}
	>;
	readonly zoneAgentToolVmProfiles?: Record<string, Record<string, string>>;
	readonly zoneDefaultToolVmProfiles?: Record<string, string>;
	readonly zoneIds?: ReadonlySet<string>;
	readonly operations?: Partial<ControllerRouteOperations>;
	readonly resolveLeaseWorkspaceDir?: (options: {
		readonly scopeKey: string;
		readonly workspaceDir: string;
		readonly zoneId: string;
	}) => Promise<string>;
}): Hono {
	const app = new Hono();
	const readIdentityPem = options.readIdentityPem ?? readIdentityPemFromFile;

	app.post('/lease', async (context) => {
		try {
			const parsedPayload = controllerLeaseCreateRequestSchema.safeParse(await context.req.json());
			if (!parsedPayload.success) {
				return context.json(
					{
						error: 'invalid-lease-request',
						issues: parsedPayload.error.issues,
					},
					400,
				);
			}
			const payload = parsedPayload.data;
			if (
				options.zoneIds
					? !options.zoneIds.has(payload.zoneId)
					: options.zoneDefaultToolVmProfiles &&
						!(payload.zoneId in options.zoneDefaultToolVmProfiles)
			) {
				return context.json({ error: `Unknown zone '${payload.zoneId}'` }, 400);
			}
			const agentId = parseAgentIdFromScopeKey(payload.scopeKey);
			const resolvedProfileId =
				(agentId ? options.zoneAgentToolVmProfiles?.[payload.zoneId]?.[agentId] : undefined) ??
				options.zoneDefaultToolVmProfiles?.[payload.zoneId] ??
				payload.profileId;
			if (!resolvedProfileId) {
				return context.json(
					{ error: `Zone '${payload.zoneId}' does not have a tool VM profile configured` },
					400,
				);
			}
			const defaultToolVmProfile = options.toolVmProfiles?.[resolvedProfileId];
			if (!defaultToolVmProfile) {
				return context.json({ error: `Unknown tool VM profile '${resolvedProfileId}'` }, 400);
			}
			const workspaceDir = options.resolveLeaseWorkspaceDir
				? await options.resolveLeaseWorkspaceDir({
						scopeKey: payload.scopeKey,
						workspaceDir: payload.workspaceDir,
						zoneId: payload.zoneId,
					})
				: payload.workspaceDir;
			const lease = await options.leaseManager.createLease({
				agentWorkspaceDir: payload.agentWorkspaceDir,
				profile: defaultToolVmProfile,
				profileId: resolvedProfileId,
				scopeKey: payload.scopeKey,
				workspaceDir,
				zoneId: payload.zoneId,
			});
			return context.json(await serializeLeaseForResponse(lease, readIdentityPem));
		} catch (error) {
			return context.json(
				{
					error: error instanceof Error ? error.message : 'lease-creation-failed',
				},
				error instanceof LeaseWorkspaceValidationError
					? 400
					: error instanceof LeaseScopeConflictError
						? 409
						: 503,
			);
		}
	});

	app.get('/lease/:leaseId/peek', async (context) => {
		const leaseSnapshot = options.leaseManager.peekLease(context.req.param('leaseId'));
		if (!leaseSnapshot) {
			return context.json({ error: 'Lease not found' }, 404);
		}
		return context.json(serializeLeasePeekForResponse(leaseSnapshot.lease));
	});

	app.get('/lease/:leaseId', async (context) => {
		const leaseRenewal = options.leaseManager.keepLeaseAlive(context.req.param('leaseId'));
		if (!leaseRenewal) {
			return context.json({ error: 'Lease not found' }, 404);
		}
		return context.json(await serializeLeaseForResponse(leaseRenewal.lease, readIdentityPem));
	});

	app.get('/leases', (context) => {
		const leases = options.leaseManager.listLeases().map((lease) => ({
			createdAt: lease.createdAt,
			id: lease.id,
			lastUsedAt: lease.lastUsedAt,
			profileId: lease.profileId,
			scopeKey: lease.scopeKey,
			tcpSlot: lease.tcpSlot,
			zoneId: lease.zoneId,
		}));
		return context.json(leases);
	});

	app.delete('/lease/:leaseId', async (context) => {
		await options.leaseManager.releaseLease(context.req.param('leaseId'));
		return context.body(null, 204);
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
		registerControllerZoneOperationRoutes(app, {
			...defaultOperations,
			...options.operations,
		});
	}

	return app;
}

export function createControllerService(options: {
	readonly leaseManager: ControllerLeaseManager;
	readonly operations?: Partial<ControllerRouteOperations>;
	readonly secretResolver?: SecretResolver;
	readonly systemConfig: SystemConfig;
}): Hono {
	const zonesById = new Map(options.systemConfig.zones.map((zone) => [zone.id, zone]));
	const app = createControllerApp({
		leaseManager: options.leaseManager,
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
		resolveLeaseWorkspaceDir: async ({ scopeKey, workspaceDir, zoneId }) => {
			const zone = zonesById.get(zoneId);
			if (!zone) {
				throw new Error(`Unknown zone '${zoneId}'`);
			}
			const resolvedWorkspaceDir = await resolveLeaseWorkspaceDirForZone({ workspaceDir, zone });
			if (options.secretResolver) {
				const seedResult = await seedAgentSandboxWorkspace({
					scopeKey,
					secretResolver: options.secretResolver,
					workspaceDir: resolvedWorkspaceDir,
					zone,
				});
				logAgentSandboxSeedResult(seedResult);
			}
			return resolvedWorkspaceDir;
		},
	});

	app.get('/health', (context) =>
		context.json({
			ok: true,
			port: options.systemConfig.host.controllerPort,
		}),
	);

	return app;
}
