import { randomUUID } from 'node:crypto';

import type { SecretResolver } from '@agent-vm/gondolin-adapter';
import { Hono } from 'hono';

import type { SystemConfig } from '../../config/system-config.js';
import {
	type AgentSandboxSeedResult,
	SandboxSeedingError,
	seedAgentSandboxWorkspace,
} from '../leases/agent-sandbox-seeding.js';
import { LeaseScopeConflictError } from '../leases/lease-manager.js';
import { parseAgentIdFromScopeKey } from '../leases/lease-scope.js';
import {
	LeaseWorkMountValidationError,
	type ResolvedLeaseWorkMount,
	resolveLeaseWorkMountDir as resolveLeaseWorkMountDirForZone,
} from '../leases/lease-work-mount-paths.js';
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

function formatUnknownError(error: unknown): string {
	if (error instanceof Error) {
		return error.stack ?? error.message;
	}
	return String(error);
}

function logLeaseCreationFailure(options: {
	readonly diagnosticId: string;
	readonly error: unknown;
	readonly requestContext: LeaseRequestLogContext | undefined;
	readonly status: number;
}): void {
	writeControllerLeaseLog(
		`[ERROR] lease creation failed diagnosticId='${options.diagnosticId}' status='${String(options.status)}' zone='${options.requestContext?.zoneId ?? '(unknown)'}' scope='${options.requestContext?.scopeKey ?? '(unknown)'}' workMountDir='${options.requestContext?.workMountDir ?? '(unknown)'}': ${formatUnknownError(options.error)}`,
	);
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
		case 'work-mount-missing':
			writeControllerLeaseLog(
				`[WARN] skipped sandbox seeding for zone '${result.zoneId}' scope '${result.scopeKey}': work mount '${result.hostWorkMountDir}' does not exist`,
			);
			return;
		case 'work-mount-outside-sandbox':
			writeControllerLeaseLog(
				`[WARN] skipped sandbox seeding for zone '${result.zoneId}' scope '${result.scopeKey}': work mount '${result.hostWorkMountDir}' is outside sandbox root '${result.sandboxRoot}'`,
			);
			return;
		case 'no-seeds-configured':
		case 'non-agent-scope':
		case 'not-openclaw-zone':
			return;
	}
}

interface LeaseRequestLogContext {
	readonly scopeKey: string;
	readonly workMountDir: string;
	readonly zoneId: string;
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
	readonly resolveLeaseWorkMountDir: (options: {
		readonly scopeKey: string;
		readonly workMountDir: string;
		readonly zoneId: string;
	}) => Promise<ResolvedLeaseWorkMount>;
}): Hono {
	const app = new Hono();
	const readIdentityPem = options.readIdentityPem ?? readIdentityPemFromFile;

	app.post('/lease', async (context) => {
		let requestContext: LeaseRequestLogContext | undefined;
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
			requestContext = {
				scopeKey: payload.scopeKey,
				workMountDir: payload.workMountDir,
				zoneId: payload.zoneId,
			};
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
			const resolvedWorkMount = await options.resolveLeaseWorkMountDir({
				scopeKey: payload.scopeKey,
				workMountDir: payload.workMountDir,
				zoneId: payload.zoneId,
			});
			const lease = await options.leaseManager.createLease({
				agentWorkspaceDir: payload.agentWorkspaceDir,
				profile: defaultToolVmProfile,
				profileId: resolvedProfileId,
				scopeKey: payload.scopeKey,
				guestWorkdir: resolvedWorkMount.guestWorkdir,
				hostWorkMountDir: resolvedWorkMount.hostWorkMountDir,
				...(resolvedWorkMount.zoneGitMount ? { zoneGitMount: resolvedWorkMount.zoneGitMount } : {}),
				zoneId: payload.zoneId,
			});
			return context.json(await serializeLeaseForResponse(lease, readIdentityPem));
		} catch (error) {
			if (error instanceof LeaseWorkMountValidationError) {
				return context.json({ error: error.message, kind: error.kind }, 400);
			}
			if (error instanceof LeaseScopeConflictError) {
				return context.json({ error: error.message }, 409);
			}
			const diagnosticId = randomUUID();
			if (error instanceof SandboxSeedingError) {
				logLeaseCreationFailure({
					diagnosticId,
					error,
					requestContext,
					status: 500,
				});
				return context.json(
					{ error: 'sandbox-seeding-failed', diagnosticId, kind: error.kind },
					500,
				);
			}
			logLeaseCreationFailure({
				diagnosticId,
				error,
				requestContext,
				status: 503,
			});
			return context.json({ error: 'lease-creation-failed', diagnosticId }, 503);
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
		resolveLeaseWorkMountDir: async ({ scopeKey, workMountDir, zoneId }) => {
			const zone = zonesById.get(zoneId);
			if (!zone) {
				throw new Error(`Unknown zone '${zoneId}'`);
			}
			const resolvedWorkMount = await resolveLeaseWorkMountDirForZone({
				runtimeDir: options.systemConfig.runtimeDir,
				workMountDir,
				zone,
			});
			if (options.secretResolver) {
				const seedResult = await seedAgentSandboxWorkspace({
					scopeKey,
					secretResolver: options.secretResolver,
					hostWorkMountDir: resolvedWorkMount.hostWorkMountDir,
					zone,
				});
				logAgentSandboxSeedResult(seedResult);
			}
			return resolvedWorkMount;
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
