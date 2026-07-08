import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import {
	buildGatewayControlCallerContextAgentAuthorityPayload,
	buildGatewayControlCallerContextProofPayload,
	type GatewayControlCallerContextRegisterPayloadSchema,
} from '@agent-vm/gateway-control-contracts';
import {
	isOpenClawAgentSessionKey,
	resolveOpenClawAgentIdFromSessionKey,
} from '@agent-vm/openclaw-agent-vm-plugin';
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
	readonly agentWorkspaceDir: string;
	readonly bootId: string;
	readonly callerContextId: string;
	readonly connectionId: string;
	readonly controllerEpoch: string;
	readonly peerId: string;
	readonly purpose: GatewayControlCallerContextPurpose;
	readonly sessionId: string;
	readonly sessionKeyDigest: string;
	readonly workMountDir: string;
	readonly zoneId: string;
}

export type GatewayControlCallerContextPurpose =
	| 'tool_portal_controller_host_action'
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
}

export const DEFAULT_GATEWAY_CONTROL_CALLER_CONTEXT_LIMIT = 1024;

export function digestGatewayControlSessionKey(sessionKey: string): string {
	return createHash('sha256').update(sessionKey, 'utf8').digest('hex');
}

function assertGatewayControlCallerContextEvidence(
	evidence: GatewayControlCallerContextRegisterPayload['adapterEvidence'],
	keys: {
		readonly agentAuthorityKeys: Readonly<Record<string, string>>;
		readonly callerContextProofKey: string;
	},
): void {
	if (!isOpenClawAgentSessionKey(evidence.sessionKey)) {
		throw new Error('gateway caller context sessionKey is not agent-shaped');
	}
	const sessionAgentId = resolveOpenClawAgentIdFromSessionKey(evidence.sessionKey);
	if (sessionAgentId !== evidence.agentId) {
		throw new Error('gateway caller context agentId does not match sessionKey agent');
	}
	const expectedDigest = createHmac('sha256', keys.callerContextProofKey)
		.update(
			buildGatewayControlCallerContextProofPayload({
				agentId: evidence.agentId,
				agentWorkspaceDir: evidence.agentWorkspaceDir,
				purpose: evidence.purpose,
				sessionKey: evidence.sessionKey,
				workMountDir: evidence.workMountDir,
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
	const agentAuthorityKey = keys.agentAuthorityKeys[evidence.agentId];
	if (agentAuthorityKey === undefined) {
		throw new Error('gateway caller context agent authority key is missing');
	}
	if (evidence.agentAuthority === undefined) {
		throw new Error('gateway caller context agent authority proof is missing');
	}
	const expectedAgentAuthorityDigest = createHmac('sha256', agentAuthorityKey)
		.update(
			buildGatewayControlCallerContextAgentAuthorityPayload({
				agentId: evidence.agentId,
				agentWorkspaceDir: evidence.agentWorkspaceDir,
				purpose: evidence.purpose,
				sessionKey: evidence.sessionKey,
				workMountDir: evidence.workMountDir,
				zoneId: evidence.zoneId,
			}),
			'utf8',
		)
		.digest('base64url');
	const expectedAgentAuthorityDigestBytes = Buffer.from(expectedAgentAuthorityDigest, 'utf8');
	const observedAgentAuthorityDigestBytes = Buffer.from(evidence.agentAuthority.digest, 'utf8');
	if (
		evidence.agentAuthority.keyId !== evidence.agentId ||
		observedAgentAuthorityDigestBytes.length !== expectedAgentAuthorityDigestBytes.length ||
		!timingSafeEqual(observedAgentAuthorityDigestBytes, expectedAgentAuthorityDigestBytes)
	) {
		throw new Error('gateway caller context agent authority proof is invalid');
	}
}

function buildCallerContextCacheKey(options: {
	readonly evidence: GatewayControlCallerContextRegisterPayload['adapterEvidence'];
	readonly session: GatewayControlCallerContextSessionRef;
}): string {
	const purpose = options.evidence.purpose ?? 'tool_vm_lease';
	return [
		options.session.zoneId,
		options.session.peerId,
		options.session.controllerEpoch,
		options.session.bootId,
		options.session.sessionId,
		options.session.connectionId,
		purpose,
		options.evidence.agentId,
		options.evidence.agentWorkspaceDir,
		options.evidence.workMountDir,
		digestGatewayControlSessionKey(options.evidence.sessionKey),
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
}): GatewayControlCallerContextRegistry {
	const agentAuthorityKeys = options.agentAuthorityKeys;
	const callerContextProofKey = options.callerContextProofKey;
	const createCallerContextId = options.createCallerContextId ?? randomUUID;
	const maxContexts = options.maxContexts ?? DEFAULT_GATEWAY_CONTROL_CALLER_CONTEXT_LIMIT;
	const contextById = new Map<string, GatewayControlTrustedCallerContext>();
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
		rememberStaleCallerContextId(callerContextId);
		const cacheKey = [
			context.zoneId,
			context.peerId,
			context.controllerEpoch,
			context.bootId,
			context.sessionId,
			context.connectionId,
			context.purpose,
			context.agentId,
			context.agentWorkspaceDir,
			context.workMountDir,
			context.sessionKeyDigest,
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

	return {
		register: ({ payload, session }) => {
			const evidence = payload.adapterEvidence;
			if (evidence.zoneId !== session.zoneId) {
				throw new Error('gateway caller context zoneId mismatch');
			}
			assertGatewayControlCallerContextEvidence(evidence, {
				agentAuthorityKeys,
				callerContextProofKey,
			});
			removeSupersededSessionContexts(session);
			const cacheKey = buildCallerContextCacheKey({ evidence, session });
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
				agentId: evidence.agentId,
				agentWorkspaceDir: evidence.agentWorkspaceDir,
				bootId: session.bootId,
				callerContextId,
				connectionId: session.connectionId,
				controllerEpoch: session.controllerEpoch,
				peerId: session.peerId,
				purpose: evidence.purpose ?? 'tool_vm_lease',
				sessionId: session.sessionId,
				sessionKeyDigest: digestGatewayControlSessionKey(evidence.sessionKey),
				workMountDir: evidence.workMountDir,
				zoneId: session.zoneId,
			} satisfies GatewayControlTrustedCallerContext;
			staleCallerContextIds.delete(callerContextId);
			contextById.set(callerContextId, context);
			contextIdByCacheKey.set(cacheKey, callerContextId);
			return context;
		},
		release: removeContext,
		resolve: (callerContextId) => contextById.get(callerContextId),
		resolveForSession: ({ callerContextId, session }) => {
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
	};
}
