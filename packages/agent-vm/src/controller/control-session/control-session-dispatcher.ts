import type {
	ControlDomain,
	ControlEnvelope,
	DomainControlMessageIdentity,
} from '@agent-vm/control-protocol-contracts';
import { CONTROL_QUEUE_LIMITS } from '@agent-vm/control-protocol-contracts';

import { assertControlSessionDispatchAllowed } from './control-session-client.js';
import type {
	GatewaySemanticJsonValue,
	GatewaySemanticExecutionProof,
	GatewaySemanticLedgerDecision,
	GatewaySemanticOperationIdentity,
	GatewaySemanticResultLedger,
} from './gateway-semantic-result-ledger.js';

export interface ControlSessionDispatchContext {
	readonly attachmentGeneration?: number;
	readonly envelope: ControlEnvelope;
	readonly payload: unknown;
}

export interface ControlSessionDomainHandler {
	assertEnvelopeDeliveryPolicy?: Parameters<
		typeof assertControlSessionDispatchAllowed
	>[0]['assertEnvelopeDeliveryPolicy'];
	buildHandlerFailureResult?(context: ControlSessionDispatchContext, error: unknown): unknown;
	buildSemanticFailureResult?(
		context: ControlSessionDispatchContext,
		decision: Exclude<GatewaySemanticLedgerDecision<unknown>, { readonly kind: 'completed' }>,
	): unknown;
	buildSemanticTransportResult?(
		context: ControlSessionDispatchContext,
		completedValue: unknown,
	): unknown;
	readonly policyByKind?: Parameters<typeof assertControlSessionDispatchAllowed>[0]['policyByKind'];
	readonly policyByOperation: Parameters<
		typeof assertControlSessionDispatchAllowed
	>[0]['policyByOperation'];
	handle(context: ControlSessionDispatchContext): Promise<unknown>;
	messageIdentity(context: ControlSessionDispatchContext): DomainControlMessageIdentity;
	prepareSemanticMutation?(
		context: ControlSessionDispatchContext,
	): Promise<PreparedControlSessionSemanticMutation | undefined>;
}

export interface PreparedControlSessionSemanticMutation {
	readonly execute: (proof: GatewaySemanticExecutionProof) => Promise<unknown>;
	readonly identity: GatewaySemanticOperationIdentity;
	readonly payload: GatewaySemanticJsonValue;
}

export interface ControlSessionFence {
	readonly bootId: string;
	readonly connectionId?: string;
	readonly controllerEpoch: string;
	readonly domain: ControlDomain;
	readonly peerId: string;
	readonly sessionId?: string;
	readonly zoneId: string;
}

export interface ControlSessionDispatcherOptions {
	readonly semanticLedger?: GatewaySemanticResultLedger;
	readonly sessionFence?: ControlSessionFence;
	readonly sessionFenceRegistry?: ControlSessionFenceRegistry;
}

export interface ControlSessionDispatcher {
	dispatch(context: ControlSessionDispatchContext): Promise<unknown>;
	register(domain: ControlDomain, handler: ControlSessionDomainHandler): void;
	validate(context: ControlSessionDispatchContext): void;
}

export interface ControlSessionFenceRegistry {
	acceptSession(fence: ControlSessionFence): void;
	assertEnvelopeAccepted(envelope: ControlEnvelope): void;
}

interface CompletedControlCommandCacheEntry {
	readonly recordedAtMs: number;
	readonly resultPromise: Promise<unknown>;
}

function assertControlEnvelopeMatchesSessionFence(
	envelope: ControlEnvelope,
	fence: ControlSessionFence,
): void {
	if (envelope.domain !== fence.domain) {
		throw new Error('control session envelope domain mismatch');
	}
	if (envelope.zoneId !== fence.zoneId) {
		throw new Error('control session envelope zoneId mismatch');
	}
	if (envelope.peerId !== fence.peerId) {
		throw new Error('control session envelope peerId mismatch');
	}
	if (envelope.bootId !== fence.bootId) {
		throw new Error('control session envelope bootId mismatch');
	}
	if (envelope.controllerEpoch !== fence.controllerEpoch) {
		throw new Error('control session envelope controllerEpoch mismatch');
	}
	if (fence.sessionId !== undefined && envelope.sessionId !== fence.sessionId) {
		throw new Error('control session envelope sessionId mismatch');
	}
	if (fence.connectionId !== undefined && envelope.connectionId !== fence.connectionId) {
		throw new Error('control session envelope connectionId mismatch');
	}
}

function buildControlSessionFenceKey(props: {
	readonly domain: ControlDomain;
	readonly peerId: string;
	readonly zoneId: string;
}): string {
	return [props.domain, props.zoneId, props.peerId].join('\u0000');
}

export function createControlSessionFenceRegistry(): ControlSessionFenceRegistry {
	const acceptedSessionByPeer = new Map<string, ControlSessionFence>();

	return {
		acceptSession: (fence) => {
			acceptedSessionByPeer.set(buildControlSessionFenceKey(fence), { ...fence });
		},
		assertEnvelopeAccepted: (envelope) => {
			const fence = acceptedSessionByPeer.get(buildControlSessionFenceKey(envelope));
			if (fence === undefined) {
				throw new Error('control session envelope has no accepted session');
			}
			assertControlEnvelopeMatchesSessionFence(envelope, fence);
		},
	};
}

function buildControlCommandDedupeKey(envelope: ControlEnvelope): string | undefined {
	if (envelope.commandId === undefined || envelope.idempotencyKey === undefined) {
		return undefined;
	}
	return [
		envelope.domain,
		envelope.zoneId,
		envelope.peerId,
		envelope.bootId,
		envelope.controllerEpoch,
		envelope.operation ?? '<none>',
		envelope.commandId,
		envelope.idempotencyKey,
	].join('\u0000');
}

function pruneCompletedControlCommandCache(
	cache: Map<string, CompletedControlCommandCacheEntry>,
	nowMs: number,
): void {
	for (const [key, entry] of cache) {
		if (nowMs - entry.recordedAtMs > CONTROL_QUEUE_LIMITS.dedupeWindowTtlMs) {
			cache.delete(key);
		}
	}
	while (cache.size > CONTROL_QUEUE_LIMITS.dedupeWindowMessages) {
		const oldestKey = cache.keys().next().value;
		if (oldestKey === undefined) {
			return;
		}
		cache.delete(oldestKey);
	}
}

function validateControlSessionDispatchContext(options: {
	readonly context: ControlSessionDispatchContext;
	readonly handler: ControlSessionDomainHandler;
	readonly sessionFence?: ControlSessionFence | undefined;
	readonly sessionFenceRegistry?: ControlSessionFenceRegistry | undefined;
}): void {
	assertControlSessionDispatchAllowed({
		...(options.handler.assertEnvelopeDeliveryPolicy === undefined
			? {}
			: { assertEnvelopeDeliveryPolicy: options.handler.assertEnvelopeDeliveryPolicy }),
		domainMessage: options.handler.messageIdentity(options.context),
		envelope: options.context.envelope,
		policyByOperation: options.handler.policyByOperation,
		...(options.handler.policyByKind === undefined
			? {}
			: { policyByKind: options.handler.policyByKind }),
	});
	if (options.sessionFence !== undefined) {
		assertControlEnvelopeMatchesSessionFence(options.context.envelope, options.sessionFence);
	}
	if (options.sessionFenceRegistry !== undefined) {
		options.sessionFenceRegistry.assertEnvelopeAccepted(options.context.envelope);
	}
}

async function handleControlSessionDispatch(options: {
	readonly context: ControlSessionDispatchContext;
	readonly handler: ControlSessionDomainHandler;
}): Promise<unknown> {
	try {
		return await options.handler.handle(options.context);
	} catch (error) {
		if (
			options.context.envelope.kind === 'command' &&
			options.handler.buildHandlerFailureResult !== undefined
		) {
			return await options.handler.buildHandlerFailureResult(options.context, error);
		}
		throw error;
	}
}

export function createControlSessionDispatcher(
	options: ControlSessionDispatcherOptions = {},
): ControlSessionDispatcher {
	const handlers = new Map<ControlDomain, ControlSessionDomainHandler>();
	const completedCommandCache = new Map<string, CompletedControlCommandCacheEntry>();

	return {
		register: (domain, handler) => {
			if (handlers.has(domain)) {
				throw new Error(`control session handler already registered for domain '${domain}'`);
			}
			handlers.set(domain, handler);
		},
		validate: (context) => {
			const handler = handlers.get(context.envelope.domain);
			if (handler === undefined) {
				throw new Error(
					`no control session handler registered for domain '${context.envelope.domain}'`,
				);
			}
			validateControlSessionDispatchContext({
				context,
				handler,
				...(options.sessionFence === undefined ? {} : { sessionFence: options.sessionFence }),
				...(options.sessionFenceRegistry === undefined
					? {}
					: { sessionFenceRegistry: options.sessionFenceRegistry }),
			});
		},
		dispatch: async (context) => {
			const handler = handlers.get(context.envelope.domain);
			if (handler === undefined) {
				throw new Error(
					`no control session handler registered for domain '${context.envelope.domain}'`,
				);
			}
			validateControlSessionDispatchContext({
				context,
				handler,
				...(options.sessionFence === undefined ? {} : { sessionFence: options.sessionFence }),
				...(options.sessionFenceRegistry === undefined
					? {}
					: { sessionFenceRegistry: options.sessionFenceRegistry }),
			});
			const semanticMutation = await handler.prepareSemanticMutation?.(context);
			if (semanticMutation !== undefined) {
				if (options.semanticLedger === undefined) {
					throw new Error('gateway semantic mutation has no configured semantic ledger');
				}
				const semanticDecision = await options.semanticLedger.executeMutating({
					handler: semanticMutation.execute,
					identity: semanticMutation.identity,
					payload: semanticMutation.payload,
				});
				if (semanticDecision.kind === 'completed') {
					return handler.buildSemanticTransportResult === undefined
						? semanticDecision.value
						: handler.buildSemanticTransportResult(context, semanticDecision.value);
				}
				if (handler.buildSemanticFailureResult !== undefined) {
					return handler.buildSemanticFailureResult(context, semanticDecision);
				}
				throw new Error(`gateway semantic mutation refused: ${semanticDecision.kind}`);
			}
			const commandDedupeKey = buildControlCommandDedupeKey(context.envelope);
			if (commandDedupeKey === undefined) {
				return await handleControlSessionDispatch({ context, handler });
			}
			const nowMs = Date.now();
			const cachedResult = completedCommandCache.get(commandDedupeKey);
			if (cachedResult !== undefined) {
				if (nowMs - cachedResult.recordedAtMs > CONTROL_QUEUE_LIMITS.dedupeWindowTtlMs) {
					completedCommandCache.delete(commandDedupeKey);
					throw new Error('control session replay window expired');
				}
				return await cachedResult.resultPromise;
			}
			pruneCompletedControlCommandCache(completedCommandCache, nowMs);
			const resultPromise = handleControlSessionDispatch({ context, handler });
			completedCommandCache.set(commandDedupeKey, {
				recordedAtMs: nowMs,
				resultPromise,
			});
			pruneCompletedControlCommandCache(completedCommandCache, nowMs);
			try {
				return await resultPromise;
			} catch (error) {
				completedCommandCache.delete(commandDedupeKey);
				throw error;
			}
		},
	};
}
