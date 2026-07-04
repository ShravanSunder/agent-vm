import { createHash, randomUUID } from 'node:crypto';

import type { GatewayControlCallerContextRegisterPayloadSchema } from '@agent-vm/gateway-control-contracts';
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

export interface GatewayControlCallerContextRegistry {
	register(options: {
		readonly payload: GatewayControlCallerContextRegisterPayload;
		readonly session: GatewayControlCallerContextSessionRef;
	}): GatewayControlTrustedCallerContext;
	release(callerContextId: string): void;
	resolve(callerContextId: string): GatewayControlTrustedCallerContext | undefined;
}

export const DEFAULT_GATEWAY_CONTROL_CALLER_CONTEXT_LIMIT = 1024;

export function digestGatewayControlSessionKey(sessionKey: string): string {
	return createHash('sha256').update(sessionKey, 'utf8').digest('hex');
}

function assertGatewayControlCallerContextEvidence(
	evidence: GatewayControlCallerContextRegisterPayload['adapterEvidence'],
): void {
	if (!isOpenClawAgentSessionKey(evidence.sessionKey)) {
		throw new Error('gateway caller context sessionKey is not agent-shaped');
	}
	const sessionAgentId = resolveOpenClawAgentIdFromSessionKey(evidence.sessionKey);
	if (sessionAgentId !== evidence.agentId) {
		throw new Error('gateway caller context agentId does not match sessionKey agent');
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

export function createGatewayControlCallerContextRegistry(
	options: {
		readonly createCallerContextId?: () => string;
		readonly maxContexts?: number;
	} = {},
): GatewayControlCallerContextRegistry {
	const createCallerContextId = options.createCallerContextId ?? randomUUID;
	const maxContexts = options.maxContexts ?? DEFAULT_GATEWAY_CONTROL_CALLER_CONTEXT_LIMIT;
	const contextById = new Map<string, GatewayControlTrustedCallerContext>();
	const contextIdByCacheKey = new Map<string, string>();

	function removeContext(callerContextId: string): void {
		const context = contextById.get(callerContextId);
		if (context === undefined) {
			return;
		}
		contextById.delete(callerContextId);
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
			assertGatewayControlCallerContextEvidence(evidence);
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
			contextById.set(callerContextId, context);
			contextIdByCacheKey.set(cacheKey, callerContextId);
			return context;
		},
		release: removeContext,
		resolve: (callerContextId) => contextById.get(callerContextId),
	};
}
