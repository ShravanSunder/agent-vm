import { randomUUID } from 'node:crypto';

import {
	CONTROL_SESSION_TIMING_MS,
	CONTROL_PROTOCOL_VERSION,
	type ControlDeliveryPolicy,
	type ControlEnvelope,
	type DomainControlMessageIdentity,
} from '@agent-vm/control-protocol-contracts';
import {
	GatewayControlRpcMessageSchema,
	gatewayControlDeliveryPolicyByKind,
	gatewayControlDeliveryPolicyByOperation,
	type GatewayControlRpcOperation,
} from '@agent-vm/gateway-control-contracts';
import type { AgentVmHealthEvent } from '@agent-vm/gateway-interface';

import type { OpenClawRuntimeStatusReport } from '../openclaw-runtime-status.js';
import type { GatewayControlIdentity, GatewayControlService } from './gateway-control-service.js';

type CreateGatewayControlId = () => string;

export interface GatewayControlEventPublisher {
	readonly publishControlSessionHeartbeat: (options: {
		readonly elapsedMs?: number;
		readonly observedAtMs: number;
	}) => Promise<void>;
	readonly publishHealthEvent: (event: AgentVmHealthEvent) => Promise<void>;
	readonly publishOpenClawRuntimeStatus: (report: OpenClawRuntimeStatusReport) => Promise<void>;
}

export interface GatewayControlEventPublisherOptions {
	readonly controlService: GatewayControlService;
	readonly createId?: CreateGatewayControlId;
	readonly identity: GatewayControlIdentity;
	readonly now?: () => number;
}

export interface GatewayControlSessionHeartbeatHandle {
	stop(): void;
}

export interface StartGatewayControlSessionHeartbeatOptions {
	readonly clearIntervalImpl?: (timer: ReturnType<typeof setInterval>) => void;
	readonly identity: GatewayControlIdentity;
	readonly intervalMs?: number;
	readonly now?: () => number;
	readonly publisher: GatewayControlEventPublisher;
	readonly setIntervalImpl?: (
		callback: () => void,
		delayMs: number,
	) => ReturnType<typeof setInterval>;
	readonly writeLog?: (message: string) => void;
}

function gatewayControlResultForHealthEvent(
	result: AgentVmHealthEvent['result'],
): 'degraded' | 'failed' | 'ok' | 'timeout' {
	return result === 'stale' ? 'degraded' : result;
}

function stringRecordFromDetails(details: unknown): Record<string, string> {
	if (typeof details !== 'object' || details === null || Array.isArray(details)) {
		return {};
	}
	return Object.fromEntries(Object.entries(details).map(([key, value]) => [key, String(value)]));
}

function healthEventCorrelation(event: AgentVmHealthEvent): Record<string, string> | undefined {
	const correlation = {
		...('causationId' in event && event.causationId !== undefined
			? { causationId: event.causationId }
			: {}),
		...('correlationId' in event && event.correlationId !== undefined
			? { correlationId: event.correlationId }
			: {}),
		...('requestId' in event && event.requestId !== undefined
			? { requestId: event.requestId }
			: {}),
		...('runId' in event && event.runId !== undefined ? { runId: event.runId } : {}),
		...('sessionKeyDigest' in event && event.sessionKeyDigest !== undefined
			? { sessionKeyDigest: event.sessionKeyDigest }
			: {}),
		...('toolCallId' in event && event.toolCallId !== undefined
			? { toolCallId: event.toolCallId }
			: {}),
		...('traceId' in event && event.traceId !== undefined ? { traceId: event.traceId } : {}),
	};
	return Object.keys(correlation).length === 0 ? undefined : correlation;
}

function healthEventPayload(event: AgentVmHealthEvent): unknown {
	const correlation = healthEventCorrelation(event);
	return {
		...('agentId' in event ? { agentId: event.agentId } : {}),
		...('attempt' in event ? { attempt: event.attempt } : {}),
		...('channelProviderId' in event ? { channelProviderId: event.channelProviderId } : {}),
		...(correlation === undefined ? {} : { correlation }),
		...('elapsedMs' in event ? { elapsedMs: event.elapsedMs } : {}),
		...('errorCode' in event ? { errorCode: event.errorCode } : {}),
		eventKind: event.kind,
		...('leaseId' in event ? { leaseId: event.leaseId } : {}),
		...('maxAttempts' in event ? { maxAttempts: event.maxAttempts } : {}),
		...('operation' in event ? { operation: event.operation } : {}),
		observedAtMs: event.observedAtMs,
		...('health' in event ? { providerRuntimeHealth: event.health.replaceAll('-', '_') } : {}),
		result: gatewayControlResultForHealthEvent(event.result),
		...('details' in event && event.details !== undefined
			? {
					safeDetails: stringRecordFromDetails(event.details),
				}
			: {}),
		...(event.kind === 'gateway-control-session'
			? {
					safeDetails: {
						...('details' in event && event.details !== undefined
							? stringRecordFromDetails(event.details)
							: {}),
						peerId: event.peerId,
					},
				}
			: {}),
		...('statusCode' in event && event.statusCode !== undefined
			? { statusCode: event.statusCode }
			: {}),
		...('useId' in event ? { useId: event.useId } : {}),
	};
}

function runtimeStatusPayload(report: OpenClawRuntimeStatusReport, observedAtMs: number): unknown {
	return {
		findings: report.findings.map((finding) => ({
			id: finding.id,
			ok: finding.ok,
			...(finding.hint === undefined ? {} : { safeMessage: finding.hint }),
			...(finding.ok ? {} : { severity: 'error' as const }),
		})),
		observedAtMs,
		statusKind: report.pluginId,
	};
}

export function createGatewayControlEventPublisher(
	options: GatewayControlEventPublisherOptions,
): GatewayControlEventPublisher {
	const createId = options.createId ?? randomUUID;
	const now = options.now ?? (() => Date.now());

	const emitEvent = async (
		operation: Extract<GatewayControlRpcOperation, 'health_event' | 'runtime_status'>,
		payload: unknown,
		emitOptions?: { readonly waitForReceipt?: boolean },
	): Promise<void> => {
		const message = GatewayControlRpcMessageSchema.parse({
			kind: 'event',
			operation,
			payload,
		});
		const acceptedSession = await options.controlService.getAcceptedSession();
		const deliveryPolicy = gatewayControlDeliveryPolicyByOperation[
			operation
		] as ControlDeliveryPolicy;
		const envelope = {
			bootId: options.identity.bootId,
			connectionId: acceptedSession.connectionId,
			controllerEpoch: options.identity.controllerEpoch,
			createdAtMs: Math.max(1, now()),
			deliveryPolicy,
			domain: 'gateway_control',
			kind: 'event',
			messageId: createId(),
			operation,
			peerId: options.identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
			sequence: options.controlService.nextPeerSequence({ deliveryPolicy }),
			sessionId: acceptedSession.sessionId,
			zoneId: options.identity.zoneId,
		} satisfies ControlEnvelope;
		const domainMessage = {
			kind: 'event',
			operation,
		} satisfies DomainControlMessageIdentity;
		if (emitOptions === undefined) {
			await options.controlService.emitApplicationMessage(envelope, domainMessage, message);
			return;
		}
		await options.controlService.emitApplicationMessage(
			envelope,
			domainMessage,
			message,
			emitOptions,
		);
	};

	return {
		publishControlSessionHeartbeat: async (payload) => {
			const message = GatewayControlRpcMessageSchema.parse({
				kind: 'heartbeat',
				payload,
			});
			const acceptedSession = await options.controlService.getAcceptedSession();
			const envelope = {
				bootId: options.identity.bootId,
				connectionId: acceptedSession.connectionId,
				controllerEpoch: options.identity.controllerEpoch,
				createdAtMs: Math.max(1, now()),
				deliveryPolicy: gatewayControlDeliveryPolicyByKind.heartbeat,
				domain: 'gateway_control',
				kind: 'heartbeat',
				messageId: createId(),
				peerId: options.identity.peerId,
				protocolVersion: CONTROL_PROTOCOL_VERSION,
				sequence: options.controlService.nextPeerSequence(),
				sessionId: acceptedSession.sessionId,
				zoneId: options.identity.zoneId,
			} satisfies ControlEnvelope;
			const domainMessage = {
				kind: 'heartbeat',
			} satisfies DomainControlMessageIdentity;
			await options.controlService.emitApplicationMessage(envelope, domainMessage, message);
		},
		publishHealthEvent: async (event) => {
			await emitEvent('health_event', healthEventPayload(event));
		},
		publishOpenClawRuntimeStatus: async (report) => {
			await emitEvent('runtime_status', runtimeStatusPayload(report, Math.max(1, now())), {
				waitForReceipt: true,
			});
		},
	};
}

export function startGatewayControlSessionHeartbeat(
	options: StartGatewayControlSessionHeartbeatOptions,
): GatewayControlSessionHeartbeatHandle {
	const intervalMs = options.intervalMs ?? CONTROL_SESSION_TIMING_MS.engineIoPingInterval;
	const now = options.now ?? (() => Date.now());
	const setIntervalImpl = options.setIntervalImpl ?? setInterval;
	const clearIntervalImpl = options.clearIntervalImpl ?? clearInterval;
	let stopped = false;
	let publishInFlight = false;

	const publishHeartbeat = async (): Promise<void> => {
		if (stopped || publishInFlight) {
			return;
		}
		publishInFlight = true;
		const observedAtMs = now();
		try {
			await options.publisher.publishControlSessionHeartbeat({
				elapsedMs: Math.max(0, now() - observedAtMs),
				observedAtMs,
			});
		} catch (error) {
			options.writeLog?.(
				`[gondolin] gateway control-session heartbeat skipped: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		} finally {
			publishInFlight = false;
		}
	};

	const timer = setIntervalImpl(() => {
		void publishHeartbeat();
	}, intervalMs);
	timer.unref?.();
	void publishHeartbeat();

	return {
		stop: () => {
			stopped = true;
			clearIntervalImpl(timer);
		},
	};
}
