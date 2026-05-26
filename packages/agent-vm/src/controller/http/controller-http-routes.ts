import { randomUUID } from 'node:crypto';

import type {
	AgentVmHealthEvent,
	StartToolVmActiveUseRequest,
	ToolVmActiveUseCorrelation,
} from '@agent-vm/gateway-interface';
import {
	isOpenClawAgentSessionKey,
	resolveOpenClawAgentIdFromSessionKey,
} from '@agent-vm/openclaw-agent-vm-plugin';
import type { SecretResolver } from '@agent-vm/secret-management';
import { type Context as ControllerRouteContext, Hono } from 'hono';

import {
	resolveControllerHealthConfig,
	type LoadedSystemConfig,
} from '../../config/system-config.js';
import { OpenClawDeploymentRequirementError } from '../../operations/openclaw-deployment-requirements.js';
import { HealthEventStore } from '../health/health-event-store.js';
import {
	type AgentSandboxSeedResult,
	SandboxSeedingError,
	seedAgentSandboxWorkspace,
} from '../leases/agent-sandbox-seeding.js';
import {
	defaultToolVmLeaseIdleTtlMs,
	resolveToolVmLeaseIdleTtlMs,
	type ToolVmLeaseIdleTtlPolicy,
} from '../leases/lease-idle-policy.js';
import {
	AgentLeaseCompatibilityConflictError,
	LeaseActiveUseConflictError,
} from '../leases/lease-manager.js';
import {
	LeaseWorkMountValidationError,
	type ResolvedLeaseWorkMount,
	resolveLeaseWorkMountDir as resolveLeaseWorkMountDirForZone,
} from '../leases/lease-work-mount-paths.js';
import {
	OpenClawRuntimeStatusStore,
	OpenClawRuntimeStatusUnavailableError,
} from '../openclaw-runtime-status.js';
import { registerControllerHealthEventRoutes } from './controller-health-event-routes.js';
import {
	type ControllerLeaseManager,
	type ControllerRuntimeReadiness,
	type ControllerRouteOperations,
	readIdentityPemFromFile,
	serializeLeasePeekForResponse,
	serializeLeaseForResponse,
} from './controller-http-route-support.js';
import {
	controllerEndActiveUseRequestSchema,
	controllerHeartbeatToolVmActiveUseRequestSchema,
	controllerLeaseCreateRequestSchema,
	controllerOpenClawRuntimeStatusRequestSchema,
	controllerStartActiveUseRequestSchema,
} from './controller-request-schemas.js';
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
		`[ERROR] lease creation failed diagnosticId='${options.diagnosticId}' status='${String(options.status)}' zone='${options.requestContext?.zoneId ?? '(unknown)'}' agent='${options.requestContext?.agentId ?? '(unknown)'}' workMountDir='${options.requestContext?.workMountDir ?? '(unknown)'}': ${formatUnknownError(options.error)}`,
	);
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

interface LeaseRequestLogContext {
	readonly agentId: string;
	readonly workMountDir: string;
	readonly zoneId: string;
}

export interface ObservedControllerLeaseCreateRequest {
	readonly agentId: string;
	readonly agentWorkspaceDir: string;
	readonly idleTtlMs?: number | undefined;
	readonly profileId: string;
	readonly sessionKey: string;
	readonly workMountDir: string;
	readonly zoneId: string;
}

interface LeaseContractErrorBody {
	readonly error: string;
	readonly guidance: string;
	readonly message: string;
	readonly received: LeaseContractReceivedFields;
}

interface LeaseContractReceivedFields {
	readonly agentId?: string;
	readonly sessionAgentId?: string;
	readonly sessionKey?: string;
}

interface AgentLeaseCompatibilityConflictResponseBody {
	readonly error: 'agent-tool-vm-lease-compatibility-conflict';
	readonly guidance: string;
	readonly message: string;
	readonly received: {
		readonly agentId?: string;
		readonly mismatchedFields: readonly string[];
		readonly zoneId?: string;
	};
}

function leaseContractErrorBody(options: LeaseContractErrorBody): LeaseContractErrorBody {
	return {
		error: options.error,
		guidance: options.guidance,
		message: options.message,
		received: options.received,
	};
}

function validateOpenClawGondolinLeaseContract(payload: {
	readonly agentId: string;
	readonly sessionKey: string;
}): LeaseContractErrorBody | null {
	if (!isOpenClawAgentSessionKey(payload.sessionKey)) {
		return leaseContractErrorBody({
			error: 'tool-vm-lease-invalid-session-key',
			message: `Lease sessionKey '${payload.sessionKey}' is not agent-shaped or contains an invalid agent id.`,
			guidance:
				'The OpenClaw plugin must send sessionKey in the form agent:<agentId>:<scope> with a valid agentId.',
			received: {
				agentId: payload.agentId,
				sessionKey: payload.sessionKey,
			},
		});
	}
	const sessionAgentId = resolveOpenClawAgentIdFromSessionKey(payload.sessionKey);
	if (sessionAgentId !== payload.agentId) {
		return leaseContractErrorBody({
			error: 'tool-vm-lease-agent-mismatch',
			message: `Lease agentId '${payload.agentId}' does not match sessionKey agent '${sessionAgentId}'.`,
			guidance:
				'The OpenClaw plugin must resolve agentId from sessionKey and send both values unchanged to the controller.',
			received: {
				agentId: payload.agentId,
				sessionAgentId,
				sessionKey: payload.sessionKey,
			},
		});
	}
	return null;
}

function agentLeaseCompatibilityConflictResponseBody(options: {
	readonly error: AgentLeaseCompatibilityConflictError;
	readonly requestContext: LeaseRequestLogContext | undefined;
}): AgentLeaseCompatibilityConflictResponseBody {
	return {
		error: 'agent-tool-vm-lease-compatibility-conflict',
		message: options.error.message,
		guidance:
			'Managed OpenClaw/Gondolin reuses one Tool VM per zone and agent. Release the existing lease or use a compatible profile/workspace/workdir.',
		received: {
			...(options.requestContext?.agentId !== undefined
				? { agentId: options.requestContext.agentId }
				: {}),
			mismatchedFields: options.error.mismatchedFields,
			...(options.requestContext?.zoneId !== undefined
				? { zoneId: options.requestContext.zoneId }
				: {}),
		},
	};
}

const defaultLeaseIdleTtlPolicy = {
	defaultMs: defaultToolVmLeaseIdleTtlMs,
	maxRequestedMs: 24 * 60 * 60 * 1000,
	minRequestedMs: 1_000,
} satisfies ToolVmLeaseIdleTtlPolicy;

const defaultHealthEventHistoryLimit = 500;
const defaultHealthEventStaleAfterMs = 30_000;

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

function recordLeaseHealthEvent(
	store: HealthEventStore,
	event: AgentVmHealthEvent & { readonly kind: 'lease-heartbeat' | 'lease-renew' },
): void {
	store.record(event);
}

interface ParsedOptionalJsonBody<TValue> {
	readonly ok: true;
	readonly value: TValue;
}

interface FailedOptionalJsonBody {
	readonly ok: false;
	readonly response: Response;
}

async function parseOptionalJsonBody<TValue>(
	context: ControllerRouteContext,
	schema: {
		safeParse(
			value: unknown,
		):
			| { readonly success: true; readonly data: TValue }
			| { readonly success: false; readonly error: { readonly issues: unknown } };
	},
	emptyValue: TValue,
): Promise<ParsedOptionalJsonBody<TValue> | FailedOptionalJsonBody> {
	const bodyText = await context.req.text();
	if (bodyText.trim() === '') {
		return { ok: true, value: emptyValue };
	}
	let parsedBody: unknown;
	try {
		parsedBody = JSON.parse(bodyText);
	} catch {
		return {
			ok: false,
			response: context.json({ error: 'Invalid JSON body' }, 400),
		};
	}
	const parsedPayload = schema.safeParse(parsedBody);
	if (!parsedPayload.success) {
		return {
			ok: false,
			response: context.json(
				{ error: 'Invalid request body', issues: parsedPayload.error.issues },
				400,
			),
		};
	}
	return { ok: true, value: parsedPayload.data };
}

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
	readonly onLeaseCreateRequest?: (request: ObservedControllerLeaseCreateRequest) => void;
	readonly leaseIdleTtlPolicy?: ToolVmLeaseIdleTtlPolicy;
	readonly operations?: Partial<ControllerRouteOperations>;
	readonly validateToolVmLeaseRequirements?: (zoneId: string) => Promise<void>;
	readonly resolveLeaseWorkMountDir: (options: {
		readonly agentId: string;
		readonly workMountDir: string;
		readonly zoneId: string;
	}) => Promise<ResolvedLeaseWorkMount>;
}): Hono {
	const app = new Hono();
	const readIdentityPem = options.readIdentityPem ?? readIdentityPemFromFile;
	const leaseIdleTtlPolicy = options.leaseIdleTtlPolicy ?? defaultLeaseIdleTtlPolicy;
	const healthEventStore =
		options.healthEventStore ??
		new HealthEventStore({
			eventHistoryLimit: defaultHealthEventHistoryLimit,
			staleAfterMs: defaultHealthEventStaleAfterMs,
		});
	const getRuntimeReadiness = (): ControllerRuntimeReadiness =>
		options.runtimeReadiness?.() ?? { ready: true, state: 'ready' };
	const rejectIfRuntimeNotReady = (): Response | null => {
		const readiness = getRuntimeReadiness();
		return readiness.ready
			? null
			: Response.json(
					{
						error: 'controller-not-ready',
						state: readiness.state,
					},
					{ status: 503 },
				);
	};

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
		now: () => Date.now(),
		store: healthEventStore,
		...(options.zoneIds ? { zoneIds: options.zoneIds } : {}),
	});

	app.post('/lease', async (context) => {
		const notReadyResponse = rejectIfRuntimeNotReady();
		if (notReadyResponse) {
			return notReadyResponse;
		}
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
			try {
				options.onLeaseCreateRequest?.(payload);
			} catch (error) {
				writeControllerLeaseLog(
					`[WARN] lease create observer failed zone='${payload.zoneId}' agent='${payload.agentId}' workMountDir='${payload.workMountDir}': ${formatUnknownError(error)}`,
				);
			}
			const agentId = payload.agentId;
			requestContext = {
				agentId,
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
			const contractError = validateOpenClawGondolinLeaseContract(payload);
			if (contractError) {
				return context.json(contractError, 400);
			}
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
				agentId,
				workMountDir: payload.workMountDir,
				zoneId: payload.zoneId,
			});
			const effectiveIdleTtl = resolveToolVmLeaseIdleTtlMs({
				policy: leaseIdleTtlPolicy,
				requestedIdleTtlMs: payload.idleTtlMs,
			});
			if (effectiveIdleTtl.kind === 'invalid') {
				return context.json(
					{ error: 'invalid-lease-idle-ttl', message: effectiveIdleTtl.message },
					400,
				);
			}
			const lease = await options.leaseManager.createLease({
				agentId,
				agentWorkspaceDir: payload.agentWorkspaceDir,
				effectiveIdleTtlMs: effectiveIdleTtl.value,
				profile: defaultToolVmProfile,
				profileId: resolvedProfileId,
				guestWorkdir: resolvedWorkMount.guestWorkdir,
				hostWorkMountDir: resolvedWorkMount.hostWorkMountDir,
				...(resolvedWorkMount.zoneGitMount ? { zoneGitMount: resolvedWorkMount.zoneGitMount } : {}),
				zoneId: payload.zoneId,
			});
			return context.json(
				await serializeLeaseForResponse(lease, readIdentityPem, {
					idleTtlMs: effectiveIdleTtl.value,
				}),
			);
		} catch (error) {
			if (error instanceof LeaseWorkMountValidationError) {
				return context.json(
					{
						error:
							error.kind === 'outside-allowed-roots'
								? 'workMountDir outside allowed roots'
								: error.kind,
						...(error.guidance !== undefined ? { guidance: error.guidance } : {}),
						kind: error.kind,
						message: error.message,
					},
					400,
				);
			}
			if (error instanceof AgentLeaseCompatibilityConflictError) {
				return context.json(
					{
						...agentLeaseCompatibilityConflictResponseBody({ error, requestContext }),
						refreshable: false,
					},
					409,
				);
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
		return context.json(
			await serializeLeaseForResponse(leaseSnapshot.lease, readIdentityPem, {
				idleTtlMs: leaseSnapshot.lease.effectiveIdleTtlMs,
			}),
		);
	});

	app.post('/lease/:leaseId/renew', async (context) => {
		const notReadyResponse = rejectIfRuntimeNotReady();
		if (notReadyResponse) {
			return notReadyResponse;
		}
		const leaseId = context.req.param('leaseId');
		const startedAtMs = Date.now();
		const preRenewSnapshot = options.leaseManager.peekLease(leaseId);
		let leaseRenewal: Awaited<ReturnType<ControllerLeaseManager['renewLease']>>;
		try {
			leaseRenewal = await options.leaseManager.renewLease(leaseId);
		} catch (error) {
			if (preRenewSnapshot) {
				recordLeaseHealthEvent(healthEventStore, {
					agentId: preRenewSnapshot.lease.agentId,
					elapsedMs: Date.now() - startedAtMs,
					errorCode: error instanceof Error ? error.name : 'lease-renew-error',
					kind: 'lease-renew',
					leaseId,
					observedAtMs: Date.now(),
					result: 'failed',
					zoneId: preRenewSnapshot.lease.zoneId,
				});
			}
			throw error;
		}
		if (leaseRenewal.kind === 'not-found') {
			if (preRenewSnapshot) {
				recordLeaseHealthEvent(healthEventStore, {
					agentId: preRenewSnapshot.lease.agentId,
					elapsedMs: Date.now() - startedAtMs,
					errorCode: leaseRenewal.reason,
					kind: 'lease-renew',
					leaseId,
					observedAtMs: Date.now(),
					result: 'failed',
					zoneId: preRenewSnapshot.lease.zoneId,
				});
			}
			return context.json(
				{
					error: 'Lease not found',
					reason: leaseRenewal.reason,
					refreshable: true,
				},
				404,
			);
		}
		recordLeaseHealthEvent(healthEventStore, {
			agentId: leaseRenewal.lease.agentId,
			elapsedMs: Date.now() - startedAtMs,
			kind: 'lease-renew',
			leaseId,
			observedAtMs: Date.now(),
			result: 'ok',
			zoneId: leaseRenewal.lease.zoneId,
		});
		return context.json(
			await serializeLeaseForResponse(leaseRenewal.lease, readIdentityPem, {
				idleTtlMs: leaseRenewal.lease.effectiveIdleTtlMs,
			}),
		);
	});

	app.get('/leases', (context) => {
		const leases = options.leaseManager.listLeases().map((lease) => ({
			agentId: lease.agentId,
			createdAt: lease.createdAt,
			id: lease.id,
			lastUsedAt: lease.lastUsedAt,
			profileId: lease.profileId,
			tcpSlot: lease.tcpSlot,
			zoneId: lease.zoneId,
		}));
		return context.json(leases);
	});

	app.delete('/lease/:leaseId', async (context) => {
		const notReadyResponse = rejectIfRuntimeNotReady();
		if (notReadyResponse) {
			return notReadyResponse;
		}
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
		const notReadyResponse = rejectIfRuntimeNotReady();
		if (notReadyResponse) {
			return notReadyResponse;
		}
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
			const startRequest: StartToolVmActiveUseRequest = {
				...(correlation ? { correlation } : {}),
				...(parsedPayload.data.report === undefined ? {} : { report: parsedPayload.data.report }),
				useId: parsedPayload.data.useId,
			};
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
		const notReadyResponse = rejectIfRuntimeNotReady();
		if (notReadyResponse) {
			return notReadyResponse;
		}
		if (!options.leaseManager.heartbeatActiveUse) {
			return context.json({ error: 'Active use API unavailable' }, 404);
		}
		const heartbeatPayload = await parseOptionalJsonBody(
			context,
			controllerHeartbeatToolVmActiveUseRequestSchema,
			{},
		);
		if (!heartbeatPayload.ok) {
			return heartbeatPayload.response;
		}
		const leaseId = context.req.param('leaseId');
		const useId = context.req.param('useId');
		const startedAtMs = Date.now();
		const leaseSnapshot = options.leaseManager.peekLease(leaseId);
		const heartbeat = options.leaseManager.heartbeatActiveUse(
			leaseId,
			useId,
			heartbeatPayload.value,
		);
		if (!heartbeat) {
			if (leaseSnapshot) {
				recordLeaseHealthEvent(healthEventStore, {
					agentId: leaseSnapshot.lease.agentId,
					elapsedMs: Date.now() - startedAtMs,
					errorCode: 'active-use-not-found',
					kind: 'lease-heartbeat',
					leaseId,
					observedAtMs: Date.now(),
					result: 'failed',
					useId,
					zoneId: leaseSnapshot.lease.zoneId,
				});
			}
			return context.json({ error: 'Active use not found' }, 404);
		}
		if (leaseSnapshot) {
			recordLeaseHealthEvent(healthEventStore, {
				agentId: leaseSnapshot.lease.agentId,
				elapsedMs: Date.now() - startedAtMs,
				kind: 'lease-heartbeat',
				leaseId,
				observedAtMs: Date.now(),
				result: 'ok',
				useId,
				zoneId: leaseSnapshot.lease.zoneId,
			});
		}
		return context.json(heartbeat);
	});

	app.delete('/lease/:leaseId/uses/:useId', async (context) => {
		const notReadyResponse = rejectIfRuntimeNotReady();
		if (notReadyResponse) {
			return notReadyResponse;
		}
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
			const notReadyResponse = rejectIfRuntimeNotReady();
			if (notReadyResponse) {
				return notReadyResponse;
			}
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
		registerControllerZoneOperationRoutes(
			app,
			{
				...defaultOperations,
				...options.operations,
			},
			{
				healthEventStore,
				now: () => Date.now(),
				runtimeReadiness: getRuntimeReadiness,
			},
		);
	}

	return app;
}

export function createControllerService(options: {
	readonly healthEventStore?: HealthEventStore;
	readonly leaseManager: ControllerLeaseManager;
	readonly onLeaseCreateRequest?: (request: ObservedControllerLeaseCreateRequest) => void;
	readonly operations?: Partial<ControllerRouteOperations>;
	readonly readIdentityPem?: (identityFilePath: string) => Promise<string>;
	readonly runtimeReadiness?: () => ControllerRuntimeReadiness;
	readonly secretResolver?: SecretResolver;
	readonly systemConfig: LoadedSystemConfig;
}): Hono {
	const zonesById = new Map(options.systemConfig.zones.map((zone) => [zone.id, zone]));
	const openClawRuntimeStatusStore = new OpenClawRuntimeStatusStore();
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
		...(options.onLeaseCreateRequest ? { onLeaseCreateRequest: options.onLeaseCreateRequest } : {}),
		...(options.readIdentityPem ? { readIdentityPem: options.readIdentityPem } : {}),
		...(options.runtimeReadiness ? { runtimeReadiness: options.runtimeReadiness } : {}),
		...(options.systemConfig.leaseIdleTtl
			? { leaseIdleTtlPolicy: options.systemConfig.leaseIdleTtl }
			: {}),
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
