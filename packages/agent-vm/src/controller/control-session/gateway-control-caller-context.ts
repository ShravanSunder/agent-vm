import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import {
	buildGatewayControlCallerContextAgentAuthorityPayload,
	buildGatewayControlCallerContextProofPayload,
	deriveGatewayControlStablePrincipal,
	type GatewayControlCallerContextRegisterPayloadSchema,
	type GatewayRuntimeTrustedInvocationPrincipal,
} from '@agent-vm/gateway-control-contracts';
import type { z } from 'zod/v4';

export type GatewayControlCallerContextRegisterPayload = z.infer<
	typeof GatewayControlCallerContextRegisterPayloadSchema
>;

export interface GatewayControlAcceptedSessionRef {
	readonly bootId: string;
	readonly controllerEpoch: string;
	readonly peerId: string;
	readonly zoneId: string;
}

export interface GatewayControlCallerContextSessionRef extends GatewayControlAcceptedSessionRef {
	readonly connectionId: string;
	readonly sessionId: string;
}

export interface GatewayControlTrustedCallerContext {
	readonly agentId: string;
	readonly bootId: string;
	readonly callerContextId: string;
	readonly connectionId: string;
	readonly controllerEpoch: string;
	readonly peerId: string;
	readonly principal: GatewayRuntimeTrustedInvocationPrincipal;
	readonly purpose: GatewayControlCallerContextPurpose;
	readonly sessionId: string;
	readonly stablePrincipal: string;
	readonly zoneId: string;
}

export type GatewayControlValidatedCallerRegistration = Omit<
	GatewayControlTrustedCallerContext,
	'callerContextId'
>;

export type GatewayControlCallerContextPurpose =
	| 'tool_portal_controller_execution'
	| 'tool_vm_lease';

export type GatewayControlCallerContextResolution =
	| {
			readonly callerContext: GatewayControlTrustedCallerContext;
			readonly status: 'ok';
	  }
	| {
			readonly status: 'absent';
	  }
	| {
			readonly status: 'stale';
	  }
	| {
			readonly status: 'session_mismatch';
	  };

export interface GatewayControlCallerContextRegistry {
	register(options: {
		readonly payload: GatewayControlCallerContextRegisterPayload;
		readonly session: GatewayControlCallerContextSessionRef;
	}): GatewayControlTrustedCallerContext;
	release(callerContextId: string): void;
	resolve(callerContextId: string): GatewayControlTrustedCallerContext | undefined;
	resolveForSession(options: {
		readonly callerContextId: string;
		readonly session: GatewayControlCallerContextSessionRef;
	}): GatewayControlCallerContextResolution;
	validateRegistrationForSession(options: {
		readonly payload: GatewayControlCallerContextRegisterPayload;
		readonly session: GatewayControlCallerContextSessionRef;
	}): GatewayControlValidatedCallerRegistration;
}

export const DEFAULT_GATEWAY_CONTROL_CALLER_CONTEXT_LIMIT = 256;
export const DEFAULT_GATEWAY_CONTROL_CALLER_CONTEXT_TTL_MS = 10 * 60 * 1_000;

function assertGatewayControlCallerContextEvidence(
	evidence: GatewayControlCallerContextRegisterPayload['adapterEvidence'],
	keys: {
		readonly agentAuthorityKeys: Readonly<Record<string, string>>;
		readonly callerContextProofKey: string;
	},
): void {
	const expectedDigest = createHmac('sha256', keys.callerContextProofKey)
		.update(
			buildGatewayControlCallerContextProofPayload({
				principal: evidence.principal,
				purpose: evidence.purpose,
				zoneId: evidence.zoneId,
			}),
			'utf8',
		)
		.digest('base64url');
	const expectedDigestBytes = Buffer.from(expectedDigest, 'utf8');
	const observedDigestBytes = Buffer.from(evidence.proof.digest, 'utf8');
	if (
		observedDigestBytes.length !== expectedDigestBytes.length ||
		!timingSafeEqual(observedDigestBytes, expectedDigestBytes)
	) {
		throw new Error('gateway caller context proof digest is invalid');
	}
	const agentAuthorityKey = keys.agentAuthorityKeys[evidence.principal.agentId];
	if (agentAuthorityKey === undefined) {
		throw new Error('gateway caller context agent authority key is missing');
	}
	if (evidence.agentAuthority === undefined) {
		throw new Error('gateway caller context agent authority proof is missing');
	}
	const expectedAgentAuthorityDigest = createHmac('sha256', agentAuthorityKey)
		.update(
			buildGatewayControlCallerContextAgentAuthorityPayload({
				principal: evidence.principal,
				purpose: evidence.purpose,
				zoneId: evidence.zoneId,
			}),
			'utf8',
		)
		.digest('base64url');
	const expectedAgentAuthorityDigestBytes = Buffer.from(expectedAgentAuthorityDigest, 'utf8');
	const observedAgentAuthorityDigestBytes = Buffer.from(evidence.agentAuthority.digest, 'utf8');
	if (
		evidence.agentAuthority.keyId !== evidence.principal.agentId ||
		observedAgentAuthorityDigestBytes.length !== expectedAgentAuthorityDigestBytes.length ||
		!timingSafeEqual(observedAgentAuthorityDigestBytes, expectedAgentAuthorityDigestBytes)
	) {
		throw new Error('gateway caller context agent authority proof is invalid');
	}
}

function buildCallerContextCacheKey(options: {
	readonly registration: GatewayControlValidatedCallerRegistration;
	readonly session: GatewayControlCallerContextSessionRef;
}): string {
	const registration = options.registration;
	return [
		options.session.zoneId,
		options.session.peerId,
		options.session.controllerEpoch,
		options.session.bootId,
		options.session.sessionId,
		options.session.connectionId,
		registration.purpose,
		deriveGatewayControlStablePrincipal({ principal: registration.principal }),
	].join('\u0000');
}

function callerContextSessionMatches(options: {
	readonly context: GatewayControlTrustedCallerContext;
	readonly session: GatewayControlCallerContextSessionRef;
}): boolean {
	return (
		options.context.bootId === options.session.bootId &&
		options.context.connectionId === options.session.connectionId &&
		options.context.controllerEpoch === options.session.controllerEpoch &&
		options.context.peerId === options.session.peerId &&
		options.context.sessionId === options.session.sessionId &&
		options.context.zoneId === options.session.zoneId
	);
}

export function createGatewayControlCallerContextRegistry(options: {
	readonly agentAuthorityKeys: Readonly<Record<string, string>>;
	readonly callerContextProofKey: string;
	readonly createCallerContextId?: () => string;
	readonly maxContexts?: number;
	readonly now?: () => number;
	readonly ttlMs?: number;
	readonly validateRegistration?: (payload: GatewayControlCallerContextRegisterPayload) => void;
}): GatewayControlCallerContextRegistry {
	const agentAuthorityKeys = options.agentAuthorityKeys;
	const callerContextProofKey = options.callerContextProofKey;
	const createCallerContextId = options.createCallerContextId ?? randomUUID;
	const maxContexts = options.maxContexts ?? DEFAULT_GATEWAY_CONTROL_CALLER_CONTEXT_LIMIT;
	const now = options.now ?? Date.now;
	const ttlMs = options.ttlMs ?? DEFAULT_GATEWAY_CONTROL_CALLER_CONTEXT_TTL_MS;
	if (!Number.isSafeInteger(maxContexts) || maxContexts <= 0) {
		throw new Error('gateway caller context maxContexts must be a positive safe integer');
	}
	if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
		throw new Error('gateway caller context ttlMs must be a positive safe integer');
	}
	const contextById = new Map<string, GatewayControlTrustedCallerContext>();
	const contextExpiryById = new Map<string, number>();
	const contextIdByCacheKey = new Map<string, string>();
	const staleCallerContextIds = new Map<string, true>();

	function rememberStaleCallerContextId(callerContextId: string): void {
		staleCallerContextIds.delete(callerContextId);
		staleCallerContextIds.set(callerContextId, true);
		while (staleCallerContextIds.size > maxContexts) {
			const oldestCallerContextId = staleCallerContextIds.keys().next().value;
			if (oldestCallerContextId === undefined) {
				return;
			}
			staleCallerContextIds.delete(oldestCallerContextId);
		}
	}

	function removeContext(callerContextId: string): void {
		const context = contextById.get(callerContextId);
		if (context === undefined) {
			return;
		}
		contextById.delete(callerContextId);
		contextExpiryById.delete(callerContextId);
		rememberStaleCallerContextId(callerContextId);
		const cacheKey = [
			context.zoneId,
			context.peerId,
			context.controllerEpoch,
			context.bootId,
			context.sessionId,
			context.connectionId,
			context.purpose,
			deriveGatewayControlStablePrincipal({ principal: context.principal }),
		].join('\u0000');
		contextIdByCacheKey.delete(cacheKey);
	}

	function removeSupersededSessionContexts(session: GatewayControlCallerContextSessionRef): void {
		for (const context of contextById.values()) {
			if (
				context.zoneId === session.zoneId &&
				context.peerId === session.peerId &&
				context.controllerEpoch === session.controllerEpoch &&
				(context.bootId !== session.bootId ||
					context.sessionId !== session.sessionId ||
					context.connectionId !== session.connectionId)
			) {
				removeContext(context.callerContextId);
			}
		}
	}

	function pruneExpiredContexts(nowMs: number): void {
		for (const [callerContextId, expiresAtMs] of contextExpiryById) {
			if (nowMs >= expiresAtMs) {
				removeContext(callerContextId);
			}
		}
	}

	function validateRegistrationForSession(validationOptions: {
		readonly payload: GatewayControlCallerContextRegisterPayload;
		readonly session: GatewayControlCallerContextSessionRef;
	}): GatewayControlValidatedCallerRegistration {
		const evidence = validationOptions.payload.adapterEvidence;
		if (evidence.zoneId !== validationOptions.session.zoneId) {
			throw new Error('gateway caller context zoneId mismatch');
		}
		assertGatewayControlCallerContextEvidence(evidence, {
			agentAuthorityKeys,
			callerContextProofKey,
		});
		if (options.validateRegistration === undefined) {
			throw new Error('gateway caller context principal validator is not configured');
		}
		options.validateRegistration(validationOptions.payload);
		return {
			agentId: evidence.principal.agentId,
			bootId: validationOptions.session.bootId,
			connectionId: validationOptions.session.connectionId,
			controllerEpoch: validationOptions.session.controllerEpoch,
			peerId: validationOptions.session.peerId,
			principal: evidence.principal,
			purpose: evidence.purpose ?? 'tool_vm_lease',
			sessionId: validationOptions.session.sessionId,
			stablePrincipal: deriveGatewayControlStablePrincipal({
				principal: evidence.principal,
			}),
			zoneId: validationOptions.session.zoneId,
		};
	}

	return {
		register: ({ payload, session }) => {
			const nowMs = now();
			pruneExpiredContexts(nowMs);
			const validatedRegistration = validateRegistrationForSession({ payload, session });
			removeSupersededSessionContexts(session);
			const cacheKey = buildCallerContextCacheKey({ registration: validatedRegistration, session });
			const existingContextId = contextIdByCacheKey.get(cacheKey);
			if (existingContextId !== undefined) {
				const existingContext = contextById.get(existingContextId);
				if (existingContext === undefined) {
					throw new Error('gateway caller context registry index is inconsistent');
				}
				return existingContext;
			}
			if (contextById.size >= maxContexts) {
				throw new Error(
					`gateway caller context registry limit exceeded: ${String(contextById.size)}/${String(maxContexts)}`,
				);
			}
			const callerContextId = createCallerContextId();
			const context = {
				...validatedRegistration,
				callerContextId,
			} satisfies GatewayControlTrustedCallerContext;
			staleCallerContextIds.delete(callerContextId);
			contextById.set(callerContextId, context);
			contextExpiryById.set(callerContextId, nowMs + ttlMs);
			contextIdByCacheKey.set(cacheKey, callerContextId);
			return context;
		},
		release: removeContext,
		resolve: (callerContextId) => {
			pruneExpiredContexts(now());
			return contextById.get(callerContextId);
		},
		resolveForSession: ({ callerContextId, session }) => {
			pruneExpiredContexts(now());
			const context = contextById.get(callerContextId);
			if (context !== undefined) {
				if (callerContextSessionMatches({ context, session })) {
					return { callerContext: context, status: 'ok' };
				}
				return { status: 'session_mismatch' };
			}
			if (staleCallerContextIds.has(callerContextId)) {
				return { status: 'stale' };
			}
			return { status: 'absent' };
		},
		validateRegistrationForSession,
	};
}
