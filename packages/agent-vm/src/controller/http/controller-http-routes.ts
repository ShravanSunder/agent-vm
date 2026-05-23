import { randomUUID } from 'node:crypto';

import type {
	StartToolVmActiveUseRequest,
	ToolVmActiveUseCorrelation,
} from '@agent-vm/gateway-interface';
import type { SecretResolver } from '@agent-vm/secret-management';
import { Hono } from 'hono';

import type { LoadedSystemConfig } from '../../config/system-config.js';
import { OpenClawDeploymentRequirementError } from '../../operations/openclaw-deployment-requirements.js';
import {
	type AgentSandboxSeedResult,
	SandboxSeedingError,
	seedAgentSandboxWorkspace,
} from '../leases/agent-sandbox-seeding.js';
import { ttlForLeaseScope, type LeaseIdleTtlPolicy } from '../leases/lease-idle-policy.js';
import { LeaseActiveUseConflictError, LeaseScopeConflictError } from '../leases/lease-manager.js';
import { parseAgentScopeKey, type AgentScopeParseResult } from '../leases/lease-scope.js';
import {
	LeaseWorkMountValidationError,
	type ResolvedLeaseWorkMount,
	resolveLeaseWorkMountDir as resolveLeaseWorkMountDirForZone,
} from '../leases/lease-work-mount-paths.js';
import {
	OpenClawRuntimeStatusStore,
	OpenClawRuntimeStatusUnavailableError,
} from '../openclaw-runtime-status.js';
import {
	type ControllerLeaseManager,
	type ControllerRouteOperations,
	readIdentityPemFromFile,
	serializeLeasePeekForResponse,
	serializeLeaseForResponse,
} from './controller-http-route-support.js';
import {
	controllerEndActiveUseRequestSchema,
	controllerLeaseCreateRequestSchema,
	controllerOpenClawRuntimeStatusRequestSchema,
	controllerStartActiveUseRequestSchema,
} from './controller-request-schemas.js';
import { registerControllerZoneOperationRoutes } from './controller-zone-operation-routes.js';

function writeControllerLeaseLog(message: string): void {
	process.stderr.write(`[controller-http-routes] ${message}\n`);
}

type InvalidAgentScopeParseResult = Exclude<AgentScopeParseResult, { readonly kind: 'agent' }>;

function assertUnreachableAgentScope(value: never): never {
	throw new Error(`Unhandled agent scope parse result: ${JSON.stringify(value)}`);
}

function formatInvalidAgentScopeReason(parsedScope: InvalidAgentScopeParseResult): string {
	switch (parsedScope.kind) {
		case 'malformed-agent-scope':
			return parsedScope.reason;
		case 'non-agent-scope':
			return 'Tool VM leases require agent-scoped OpenClaw sandboxes.';
		default:
			return assertUnreachableAgentScope(parsedScope);
	}
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

const defaultLeaseIdleTtlPolicy = {
	defaultMs: 30 * 60 * 1000,
	maxRequestedMs: 24 * 60 * 60 * 1000,
	minRequestedMs: 1_000,
	byScopeKind: {},
	byScopePrefix: {},
} satisfies LeaseIdleTtlPolicy;

function resolveEffectiveIdleTtlMs(options: {
	readonly policy: LeaseIdleTtlPolicy;
	readonly requestedIdleTtlMs: number | undefined;
	readonly scopeKey: string;
}):
	| { readonly kind: 'ok'; readonly value: number }
	| { readonly kind: 'invalid'; readonly message: string } {
	if (options.requestedIdleTtlMs === undefined) {
		return {
			kind: 'ok',
			value: ttlForLeaseScope({ policy: options.policy, scopeKey: options.scopeKey }),
		};
	}
	if (options.requestedIdleTtlMs < options.policy.minRequestedMs) {
		return {
			kind: 'invalid',
			message: `Requested idleTtlMs must be at least ${String(options.policy.minRequestedMs)}ms.`,
		};
	}
	if (options.requestedIdleTtlMs > options.policy.maxRequestedMs) {
		return {
			kind: 'invalid',
			message: `Requested idleTtlMs must be at most ${String(options.policy.maxRequestedMs)}ms.`,
		};
	}
	return { kind: 'ok', value: options.requestedIdleTtlMs };
}

function normalizeActiveUseCorrelation(
	correlation:
		| {
				readonly agentId?: string | undefined;
				readonly sessionId?: string | undefined;
				readonly sessionKey?: string | undefined;
				readonly toolCallId?: string | undefined;
				readonly toolName?: string | undefined;
		  }
		| undefined,
): ToolVmActiveUseCorrelation | undefined {
	if (!correlation) {
		return undefined;
	}
	const normalizedCorrelation = {
		...(correlation.agentId !== undefined ? { agentId: correlation.agentId } : {}),
		...(correlation.sessionId !== undefined ? { sessionId: correlation.sessionId } : {}),
		...(correlation.sessionKey !== undefined ? { sessionKey: correlation.sessionKey } : {}),
		...(correlation.toolCallId !== undefined ? { toolCallId: correlation.toolCallId } : {}),
		...(correlation.toolName !== undefined ? { toolName: correlation.toolName } : {}),
	} satisfies ToolVmActiveUseCorrelation;
	return Object.keys(normalizedCorrelation).length > 0 ? normalizedCorrelation : undefined;
}

export function createControllerApp(options: {
	readonly leaseManager: ControllerLeaseManager;
	readonly readIdentityPem?: (identityFilePath: string) => Promise<string>;
	readonly ttlForLease?: (lease: { readonly scopeKey: string }) => number;
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
	readonly openClawRuntimeStatusStore?: OpenClawRuntimeStatusStore;
	readonly leaseIdleTtlPolicy?: LeaseIdleTtlPolicy;
	readonly operations?: Partial<ControllerRouteOperations>;
	readonly validateToolVmLeaseRequirements?: (zoneId: string) => Promise<void>;
	readonly resolveLeaseWorkMountDir: (options: {
		readonly scopeKey: string;
		readonly workMountDir: string;
		readonly zoneId: string;
	}) => Promise<ResolvedLeaseWorkMount>;
}): Hono {
	const app = new Hono();
	const readIdentityPem = options.readIdentityPem ?? readIdentityPemFromFile;
	const leaseIdleTtlPolicy = options.leaseIdleTtlPolicy ?? defaultLeaseIdleTtlPolicy;

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
			const parsedScope = parseAgentScopeKey(payload.scopeKey);
			if (parsedScope.kind !== 'agent') {
				const reason = formatInvalidAgentScopeReason(parsedScope);
				return context.json(
					{
						error: `Invalid Tool VM lease scope '${payload.scopeKey}': ${reason}`,
						kind: parsedScope.kind,
					},
					400,
				);
			}
			const agentId = parsedScope.agentId;
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
			await options.validateToolVmLeaseRequirements?.(payload.zoneId);
			const resolvedWorkMount = await options.resolveLeaseWorkMountDir({
				scopeKey: payload.scopeKey,
				workMountDir: payload.workMountDir,
				zoneId: payload.zoneId,
			});
			const effectiveIdleTtl = resolveEffectiveIdleTtlMs({
				policy: leaseIdleTtlPolicy,
				requestedIdleTtlMs: payload.idleTtlMs,
				scopeKey: payload.scopeKey,
			});
			if (effectiveIdleTtl.kind === 'invalid') {
				return context.json(
					{ error: 'invalid-lease-idle-ttl', message: effectiveIdleTtl.message },
					400,
				);
			}
			const lease = await options.leaseManager.createLease({
				agentWorkspaceDir: payload.agentWorkspaceDir,
				effectiveIdleTtlMs: effectiveIdleTtl.value,
				profile: defaultToolVmProfile,
				profileId: resolvedProfileId,
				scopeKey: payload.scopeKey,
				guestWorkdir: resolvedWorkMount.guestWorkdir,
				hostWorkMountDir: resolvedWorkMount.hostWorkMountDir,
				...(resolvedWorkMount.zoneGitMount ? { zoneGitMount: resolvedWorkMount.zoneGitMount } : {}),
				zoneId: payload.zoneId,
			});
			const idleTtlMs = options.ttlForLease?.(lease);
			return context.json(
				await serializeLeaseForResponse(
					lease,
					readIdentityPem,
					idleTtlMs !== undefined ? { idleTtlMs } : {},
				),
			);
		} catch (error) {
			if (error instanceof LeaseWorkMountValidationError) {
				return context.json({ error: error.message, kind: error.kind }, 400);
			}
			if (error instanceof LeaseScopeConflictError) {
				return context.json({ error: error.message }, 409);
			}
			if (error instanceof OpenClawDeploymentRequirementError) {
				return context.json({ error: error.message, kind: error.kind }, 400);
			}
			if (error instanceof OpenClawRuntimeStatusUnavailableError) {
				return context.json({ error: error.message, kind: error.kind }, 409);
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
		const leaseSnapshot = options.leaseManager.peekLease(context.req.param('leaseId'));
		if (!leaseSnapshot) {
			return context.json({ error: 'Lease not found' }, 404);
		}
		return context.json(await serializeLeaseForResponse(leaseSnapshot.lease, readIdentityPem));
	});

	app.post('/lease/:leaseId/renew', async (context) => {
		const leaseRenewal = options.leaseManager.renewLease(context.req.param('leaseId'));
		if (!leaseRenewal) {
			return context.json({ error: 'Lease not found' }, 404);
		}
		const idleTtlMs = options.ttlForLease?.(leaseRenewal.lease);
		return context.json(
			await serializeLeaseForResponse(
				leaseRenewal.lease,
				readIdentityPem,
				idleTtlMs !== undefined ? { idleTtlMs } : {},
			),
		);
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
		try {
			await options.leaseManager.releaseLease(context.req.param('leaseId'), {
				force: context.req.query('force') === 'true',
			});
			return context.body(null, 204);
		} catch (error) {
			if (error instanceof LeaseActiveUseConflictError) {
				return context.json({ error: error.message, kind: 'active-lease-conflict' }, 409);
			}
			throw error;
		}
	});

	app.post('/lease/:leaseId/uses', async (context) => {
		if (!options.leaseManager.startActiveUse) {
			return context.json({ error: 'Active use API unavailable' }, 404);
		}
		const parsedPayload = controllerStartActiveUseRequestSchema.safeParse(await context.req.json());
		if (!parsedPayload.success) {
			return context.json(
				{
					error: 'invalid-active-use-request',
					issues: parsedPayload.error.issues,
				},
				400,
			);
		}
		try {
			const correlation = normalizeActiveUseCorrelation(parsedPayload.data.correlation);
			const startRequest: StartToolVmActiveUseRequest = correlation
				? {
						correlation,
						useId: parsedPayload.data.useId,
					}
				: { useId: parsedPayload.data.useId };
			const activeUse = options.leaseManager.startActiveUse(
				context.req.param('leaseId'),
				startRequest,
			);
			if (!activeUse) {
				return context.json({ error: 'Lease not found' }, 404);
			}
			return context.json(activeUse);
		} catch (error) {
			if (error instanceof LeaseActiveUseConflictError) {
				return context.json({ error: error.message, kind: 'active-use-conflict' }, 409);
			}
			throw error;
		}
	});

	app.post('/lease/:leaseId/uses/:useId/heartbeat', async (context) => {
		if (!options.leaseManager.heartbeatActiveUse) {
			return context.json({ error: 'Active use API unavailable' }, 404);
		}
		const heartbeat = options.leaseManager.heartbeatActiveUse(
			context.req.param('leaseId'),
			context.req.param('useId'),
		);
		if (!heartbeat) {
			return context.json({ error: 'Active use not found' }, 404);
		}
		return context.json(heartbeat);
	});

	app.delete('/lease/:leaseId/uses/:useId', async (context) => {
		if (!options.leaseManager.endActiveUse) {
			return context.json({ error: 'Active use API unavailable' }, 404);
		}
		const parsedPayload = controllerEndActiveUseRequestSchema.safeParse(await context.req.json());
		if (!parsedPayload.success) {
			return context.json(
				{
					error: 'invalid-active-use-end-request',
					issues: parsedPayload.error.issues,
				},
				400,
			);
		}
		const result = options.leaseManager.endActiveUse(
			context.req.param('leaseId'),
			context.req.param('useId'),
			parsedPayload.data,
		);
		if (!result) {
			return context.json({ error: 'Lease not found' }, 404);
		}
		return context.body(null, 204);
	});

	if (options.openClawRuntimeStatusStore) {
		const openClawRuntimeStatusStore = options.openClawRuntimeStatusStore;
		app.post('/zones/:zoneId/openclaw-runtime-status', async (context) => {
			const zoneId = context.req.param('zoneId');
			if (options.zoneIds && !options.zoneIds.has(zoneId)) {
				return context.json({ error: `Unknown zone '${zoneId}'` }, 404);
			}
			let requestBody: unknown;
			try {
				requestBody = await context.req.json();
			} catch {
				return context.json(
					{
						error: 'invalid-json-request',
						message: 'Request body must be valid JSON.',
					},
					400,
				);
			}
			const parsedPayload = controllerOpenClawRuntimeStatusRequestSchema.safeParse(requestBody);
			if (!parsedPayload.success) {
				return context.json(
					{
						error: 'invalid-openclaw-runtime-status',
						issues: parsedPayload.error.issues,
					},
					400,
				);
			}
			const payload = parsedPayload.data;
			if (payload.zoneId !== zoneId) {
				return context.json(
					{
						error: `OpenClaw runtime status zone '${payload.zoneId}' does not match route zone '${zoneId}'.`,
					},
					400,
				);
			}
			const snapshot = openClawRuntimeStatusStore.record(payload);
			return context.json({
				ok: true,
				receivedAtMs: snapshot.receivedAtMs,
				zoneId: snapshot.zoneId,
			});
		});
	}

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
	readonly readIdentityPem?: (identityFilePath: string) => Promise<string>;
	readonly secretResolver?: SecretResolver;
	readonly systemConfig: LoadedSystemConfig;
	readonly ttlForLease: (lease: { readonly scopeKey: string }) => number;
}): Hono {
	const zonesById = new Map(options.systemConfig.zones.map((zone) => [zone.id, zone]));
	const openClawRuntimeStatusStore = new OpenClawRuntimeStatusStore();
	const app = createControllerApp({
		leaseManager: options.leaseManager,
		...(options.readIdentityPem ? { readIdentityPem: options.readIdentityPem } : {}),
		...(options.systemConfig.leaseIdleTtl
			? { leaseIdleTtlPolicy: options.systemConfig.leaseIdleTtl }
			: {}),
		ttlForLease: options.ttlForLease,
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
