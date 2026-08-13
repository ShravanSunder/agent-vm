import type {
	AgentVmHealthEvent,
	GatewayRecoveryEventAction,
	GatewayRecoveryTimeoutErrorCode,
} from '@agent-vm/gateway-lifecycle';

import {
	classifyControlSessionDeathGrace,
	recordControlSessionDisconnected,
	recordControlSessionReconnected,
	type ControlSessionDeathGraceState,
} from '../control-session/control-session-death-grace.js';
import { writeControllerDiagnostic } from '../controller-diagnostic-logging.js';
import {
	deriveChannelProviderRecoveryObservation,
	type AgentChannelProviderHealthEvent,
} from './channel-provider-recovery-observation.js';
import {
	createGatewayVmRecoveryTracker,
	defaultGatewayVmChannelProviderRecoveryPolicy,
	type GatewayVmRecoveryCorroborationState,
	type GatewayVmAutoRecoveryPolicy,
	type GatewayVmRecoveryBudgetClass,
	type GatewayVmRecoveryDecision,
	type GatewayVmRecoveryObservationResult,
	type GatewayVmRecoveryReason,
	type GatewayVmRecoverySourceKey,
} from './gateway-vm-recovery-policy.js';
import type { HealthEventStore } from './health-event-store.js';

export interface GatewayServiceHealthProbeResult {
	readonly ok: boolean;
	readonly path: string;
	readonly port: number;
	readonly statusCode?: number | undefined;
	readonly zoneId: string;
}

export interface GatewayServiceHealthMonitor {
	recoverFromTerminalAttachmentLoss(request: TerminalAttachmentLossRecoveryRequest): Promise<void>;
	start(): void;
	stop(): Promise<void>;
	tick(): Promise<void>;
}

export interface TerminalAttachmentLossRecoveryRequest {
	readonly sourceKey: GatewayVmRecoverySourceKey;
	readonly zoneId: string;
}

export interface GatewayVmRecoveryRequest {
	readonly consecutiveFailures: number;
	readonly reason: GatewayVmRecoveryReason;
	readonly sourceKey?: GatewayVmRecoverySourceKey | undefined;
	readonly zoneId: string;
}

export interface DeadControlSessionRecoveryRequest {
	readonly sourceKey: GatewayVmRecoverySourceKey;
	readonly zoneId: string;
}

export interface ClassifyRecoveryBudgetClassRequest {
	readonly consecutiveFailures: number;
	readonly reason: GatewayVmRecoveryReason;
	readonly zoneId: string;
}

export type GatewayVmRecoveryResult =
	| {
			readonly action?: 'gateway-vm-restart' | undefined;
			readonly elapsedMs: number;
			readonly leaseReleaseFailureCount: number;
			readonly newBootedAt: string;
			readonly newHostPid: number;
			readonly newVmId: string;
			readonly oldBootedAt: string;
			readonly oldHostPid: number;
			readonly oldVmId: string;
			readonly operationId?: string | undefined;
			readonly result: 'ok';
	  }
	| {
			readonly action: 'gateway-vm-cold-start';
			readonly elapsedMs: number;
			readonly leaseReleaseFailureCount: number;
			readonly newBootedAt: string;
			readonly newHostPid: number;
			readonly newVmId: string;
			readonly operationId?: string | undefined;
			readonly result: 'ok';
	  }
	| {
			readonly action: 'gateway-vm-restart';
			readonly elapsedMs: number;
			readonly errorCode: string;
			readonly leaseReleaseFailureCount?: number | undefined;
			readonly oldBootedAt?: string | undefined;
			readonly oldHostPid?: number | undefined;
			readonly oldVmId: string;
			readonly operationId?: string | undefined;
			readonly result: 'failed';
	  }
	| {
			readonly action: 'gateway-vm-restart';
			readonly elapsedMs: number;
			readonly errorCode: GatewayRecoveryTimeoutErrorCode;
			readonly leaseReleaseFailureCount?: number | undefined;
			readonly oldBootedAt?: string | undefined;
			readonly oldHostPid?: number | undefined;
			readonly oldVmId?: string | undefined;
			readonly operationId?: string | undefined;
			readonly result: 'failed';
	  }
	| {
			readonly action: 'gateway-vm-cold-start' | 'observe-only' | 'operator-required';
			readonly elapsedMs: number;
			readonly errorCode: string;
			readonly leaseReleaseFailureCount?: number | undefined;
			readonly oldBootedAt?: undefined;
			readonly oldHostPid?: undefined;
			readonly oldVmId?: undefined;
			readonly operationId?: string | undefined;
			readonly result: 'failed';
	  };

export interface CreateGatewayServiceHealthMonitorOptions {
	readonly clearIntervalImpl?: ((timer: NodeJS.Timeout) => void) | undefined;
	readonly clearTimeoutImpl?: ((timer: NodeJS.Timeout) => void) | undefined;
	readonly classifyRecoveryBudgetClass?:
		| ((request: ClassifyRecoveryBudgetClassRequest) => GatewayVmRecoveryBudgetClass)
		| undefined;
	readonly controlSessionDeathGraceMs?: number | undefined;
	readonly gatewayServiceAutoRestart: GatewayVmAutoRecoveryPolicy;
	readonly healthEventStore: HealthEventStore;
	readonly intervalMs: number;
	readonly now: () => number;
	readonly probeZoneHealth: (zoneId: string) => Promise<GatewayServiceHealthProbeResult>;
	readonly recoverGatewayVm?:
		| ((request: GatewayVmRecoveryRequest) => Promise<GatewayVmRecoveryResult>)
		| undefined;
	readonly recoverDeadControlSession?:
		| ((request: DeadControlSessionRecoveryRequest) => Promise<void>)
		| undefined;
	readonly resolveGatewayRecoverySourceKey?:
		| ((request: {
				readonly latestControlSessionEvent?:
					| (AgentVmHealthEvent & { readonly kind: 'gateway-control-session' })
					| undefined;
				readonly zoneId: string;
		  }) => GatewayVmRecoverySourceKey | undefined)
		| undefined;
	readonly setIntervalImpl?:
		| ((callback: () => void | Promise<void>, delayMs: number) => NodeJS.Timeout)
		| undefined;
	readonly setTimeoutImpl?: ((callback: () => void, delayMs: number) => NodeJS.Timeout) | undefined;
	readonly staleAfterMs: number;
	readonly zoneIds: readonly string[];
}

type GatewayServiceHealthDiagnosticOperation =
	| 'gateway-recovery-budget-classification'
	| 'gateway-service-health-probe'
	| 'gateway-vm-recovery-while-stopped'
	| 'scheduled-gateway-health-tick'
	| 'gateway-channel-provider-recovery-while-stopped'
	| 'gateway-control-session-recovery';

function writeGatewayServiceHealthMonitorLog(telemetry: {
	readonly operation: GatewayServiceHealthDiagnosticOperation;
	readonly zoneId?: string | undefined;
}): void {
	writeControllerDiagnostic('gateway', {
		event: 'gateway-health-diagnostic',
		level: 'warning',
		failureClass: 'failure',
		telemetry,
	});
}

const unknownGatewayServiceHealthTarget = {
	path: '(unknown)',
	port: 0,
} as const;

function channelProviderEventKey(event: AgentChannelProviderHealthEvent): string {
	return `${event.zoneId}\0${event.channelProviderId}\0${String(event.observedAtMs)}`;
}

function gatewayRecoverySourceKeyFingerprint(sourceKey: GatewayVmRecoverySourceKey): string {
	return [
		sourceKey.domain,
		sourceKey.zoneId,
		sourceKey.gatewayVmId,
		sourceKey.bootId,
		sourceKey.generationId,
	].join('\0');
}

function controlSessionEventFingerprint(
	event: AgentVmHealthEvent & { readonly kind: 'gateway-control-session' },
): string {
	return [
		event.kind,
		event.zoneId,
		event.peerId,
		event.operation,
		event.result,
		String(event.observedAtMs),
		String(event.elapsedMs),
	].join('\0');
}

function recoveryActionForBudgetClass(
	recoveryBudgetClass: GatewayVmRecoveryBudgetClass,
): Extract<GatewayRecoveryEventAction, 'gateway-vm-cold-start' | 'gateway-vm-restart'> {
	return recoveryBudgetClass === 'gateway-vm-cold-start'
		? 'gateway-vm-cold-start'
		: 'gateway-vm-restart';
}

function budgetResultForRecoveryResult(
	result: GatewayVmRecoveryResult,
): 'failed' | 'ok' | undefined {
	return result.action === 'observe-only' || result.action === 'operator-required'
		? undefined
		: result.result;
}

function isGatewayRecoveryTimeoutErrorCodeValue(
	value: string,
): value is GatewayRecoveryTimeoutErrorCode {
	return value === 'recovery-callback-unconfigured' || value === 'recovery-timeout';
}

class GatewayRecoveryDeadlineExceededError extends Error {
	constructor() {
		super('gateway recovery deadline exceeded');
		this.name = 'GatewayRecoveryDeadlineExceededError';
	}
}

export function createGatewayServiceHealthMonitor(
	options: CreateGatewayServiceHealthMonitorOptions,
): GatewayServiceHealthMonitor {
	const setIntervalImpl = options.setIntervalImpl ?? setInterval;
	const clearIntervalImpl = options.clearIntervalImpl ?? clearInterval;
	const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
	const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
	const recoveryPolicy = options.gatewayServiceAutoRestart;
	const channelProviderPolicy =
		recoveryPolicy.channelProviderHealth ?? defaultGatewayVmChannelProviderRecoveryPolicy;
	const recoveryTracker = createGatewayVmRecoveryTracker({ policy: recoveryPolicy });
	let timer: NodeJS.Timeout | undefined;
	let runningTick: Promise<void> | undefined;
	const runningTerminalAttachmentRecoveryByZoneId = new Map<string, Promise<void>>();
	const recoveredChannelProviderEventKeys = new Set<string>();
	const controlSessionRecoveryRetryAtMsByEventKey = new Map<string, number>();
	const controlSessionDeathGraceByZoneId = new Map<string, ControlSessionDeathGraceState>();
	const controlSessionSourceFrontierByZoneId = new Map<
		string,
		{
			quarantinedEventFingerprint: string | undefined;
			sourceKeyFingerprint: string;
		}
	>();
	let stopped = false;

	const runWithRecoveryDeadline = async <TResult>(
		operation: Promise<TResult>,
	): Promise<TResult> => {
		let timeout: NodeJS.Timeout | undefined;
		const timeoutPromise = new Promise<never>((_resolve, reject) => {
			timeout = setTimeoutImpl(
				() => reject(new GatewayRecoveryDeadlineExceededError()),
				recoveryPolicy.restartTimeoutMs,
			);
			timeout.unref?.();
		});
		try {
			return await Promise.race([operation, timeoutPromise]);
		} finally {
			if (timeout !== undefined) {
				clearTimeoutImpl(timeout);
			}
		}
	};

	const classifyRecoveryBudgetClass = (
		request: ClassifyRecoveryBudgetClassRequest,
	): GatewayVmRecoveryBudgetClass => {
		try {
			return options.classifyRecoveryBudgetClass?.(request) ?? 'gateway-vm-restart';
		} catch {
			writeGatewayServiceHealthMonitorLog({
				operation: 'gateway-recovery-budget-classification',
				zoneId: request.zoneId,
			});
			return 'gateway-vm-restart';
		}
	};

	const latestGatewayControlSessionEvent = (
		zoneId: string,
	): (AgentVmHealthEvent & { readonly kind: 'gateway-control-session' }) | undefined =>
		options.healthEventStore
			.listLatestEventsForZone(zoneId)
			.find(
				(event): event is AgentVmHealthEvent & { readonly kind: 'gateway-control-session' } =>
					event.kind === 'gateway-control-session',
			);

	const controlSessionEventBelongsToCurrentSource = (props: {
		readonly event: (AgentVmHealthEvent & { readonly kind: 'gateway-control-session' }) | undefined;
		readonly sourceKey: GatewayVmRecoverySourceKey | undefined;
		readonly zoneId: string;
	}): 'current' | 'source-changed' | 'unattributed' => {
		if (props.sourceKey === undefined) {
			return 'unattributed';
		}
		const sourceKeyFingerprint = gatewayRecoverySourceKeyFingerprint(props.sourceKey);
		const existingFrontier = controlSessionSourceFrontierByZoneId.get(props.zoneId);
		if (existingFrontier === undefined) {
			controlSessionSourceFrontierByZoneId.set(props.zoneId, {
				quarantinedEventFingerprint: undefined,
				sourceKeyFingerprint,
			});
			return 'current';
		}
		if (existingFrontier.sourceKeyFingerprint !== sourceKeyFingerprint) {
			controlSessionDeathGraceByZoneId.delete(props.zoneId);
			controlSessionSourceFrontierByZoneId.set(props.zoneId, {
				quarantinedEventFingerprint:
					props.event === undefined ? undefined : controlSessionEventFingerprint(props.event),
				sourceKeyFingerprint,
			});
			return 'source-changed';
		}
		if (existingFrontier.quarantinedEventFingerprint === undefined) {
			return 'current';
		}
		if (
			props.event !== undefined &&
			controlSessionEventFingerprint(props.event) === existingFrontier.quarantinedEventFingerprint
		) {
			return 'unattributed';
		}
		existingFrontier.quarantinedEventFingerprint = undefined;
		return 'current';
	};

	const classifyGatewayControlSessionObservation = (props: {
		readonly controlLinkEvent:
			| (AgentVmHealthEvent & { readonly kind: 'gateway-control-session' })
			| undefined;
		readonly nowMs: number;
		readonly zoneId: string;
	}): {
		readonly deathGrace: GatewayVmRecoveryCorroborationState | undefined;
		readonly latestEvent?:
			| (AgentVmHealthEvent & { readonly kind: 'gateway-control-session' })
			| undefined;
		readonly result: GatewayVmRecoveryObservationResult;
	} => {
		const controlLinkEvent = props.controlLinkEvent;
		if (!controlLinkEvent) {
			return { deathGrace: undefined, result: 'unobserved' };
		}
		const result =
			props.nowMs - controlLinkEvent.observedAtMs > options.staleAfterMs
				? 'stale'
				: controlLinkEvent.result;
		if (result === 'ok') {
			controlSessionDeathGraceByZoneId.set(
				props.zoneId,
				recordControlSessionReconnected({
					previousState: controlSessionDeathGraceByZoneId.get(props.zoneId) ?? {
						kind: 'connected',
					},
				}),
			);
			return { deathGrace: 'connected', latestEvent: controlLinkEvent, result };
		}
		const deathGraceState = recordControlSessionDisconnected({
			nowMs: props.nowMs,
			previousState: controlSessionDeathGraceByZoneId.get(props.zoneId) ?? { kind: 'connected' },
		});
		controlSessionDeathGraceByZoneId.set(props.zoneId, deathGraceState);
		const deathGraceClassification = classifyControlSessionDeathGrace({
			...(options.controlSessionDeathGraceMs === undefined
				? {}
				: { graceMs: options.controlSessionDeathGraceMs }),
			nowMs: props.nowMs,
			state: deathGraceState,
		});
		return {
			deathGrace:
				deathGraceClassification.kind === 'recovery_due' ? 'recovery-due' : 'within-grace',
			latestEvent: controlLinkEvent,
			result,
		};
	};

	const latestChannelProviderHealthEvents = (
		zoneId: string,
	): readonly AgentChannelProviderHealthEvent[] =>
		options.healthEventStore
			.listLatestEventsForZone(zoneId)
			.filter(
				(event): event is AgentChannelProviderHealthEvent =>
					event.kind === 'agent-channel-provider-health',
			);

	const runRecovery = async (
		request: GatewayVmRecoveryRequest,
		intendedAction: Extract<
			GatewayRecoveryEventAction,
			'gateway-vm-cold-start' | 'gateway-vm-restart'
		>,
	): Promise<GatewayVmRecoveryResult> => {
		if (!options.recoverGatewayVm) {
			return intendedAction === 'gateway-vm-restart'
				? {
						action: 'gateway-vm-restart',
						elapsedMs: 0,
						errorCode: 'recovery-callback-unconfigured',
						result: 'failed',
					}
				: {
						action: 'gateway-vm-cold-start',
						elapsedMs: 0,
						errorCode: 'recovery-callback-unconfigured',
						result: 'failed',
					};
		}
		try {
			return await runWithRecoveryDeadline(options.recoverGatewayVm(request));
		} catch (error) {
			const errorCode =
				error instanceof GatewayRecoveryDeadlineExceededError
					? 'recovery-timeout'
					: 'recovery-callback-failed';
			if (intendedAction === 'gateway-vm-cold-start') {
				return {
					action: 'gateway-vm-cold-start',
					elapsedMs: recoveryPolicy.restartTimeoutMs,
					errorCode,
					result: 'failed',
				};
			}
			return errorCode === 'recovery-timeout'
				? {
						action: 'gateway-vm-restart',
						elapsedMs: recoveryPolicy.restartTimeoutMs,
						errorCode,
						result: 'failed',
					}
				: {
						action: 'gateway-vm-restart',
						elapsedMs: recoveryPolicy.restartTimeoutMs,
						errorCode,
						oldVmId: request.sourceKey?.gatewayVmId ?? '(unknown-gateway-vm)',
						result: 'failed',
					};
		}
	};

	const recordGatewayRecoveryEvent = (props: {
		readonly consecutiveFailures: number;
		readonly observedAtMs: number;
		readonly reason: GatewayVmRecoveryReason;
		readonly result: GatewayVmRecoveryResult;
		readonly zoneId: string;
	}): void => {
		const recoveryAction = props.result.action ?? 'gateway-vm-restart';
		if (props.result.result === 'ok') {
			const event =
				props.result.action !== 'gateway-vm-cold-start'
					? ({
							action: 'gateway-vm-restart',
							consecutiveFailures: props.consecutiveFailures,
							cooldownMs: recoveryPolicy.cooldownMs,
							elapsedMs: props.result.elapsedMs,
							kind: 'gateway-recovery',
							leaseReleaseFailureCount: props.result.leaseReleaseFailureCount,
							newBootedAt: props.result.newBootedAt,
							newHostPid: props.result.newHostPid,
							newVmId: props.result.newVmId,
							observedAtMs: props.observedAtMs,
							oldBootedAt: props.result.oldBootedAt,
							oldHostPid: props.result.oldHostPid,
							oldVmId: props.result.oldVmId,
							...(props.result.operationId === undefined
								? {}
								: { operationId: props.result.operationId }),
							reason: props.reason,
							result: 'ok',
							zoneId: props.zoneId,
						} satisfies AgentVmHealthEvent)
					: ({
							action: 'gateway-vm-cold-start',
							consecutiveFailures: props.consecutiveFailures,
							cooldownMs: recoveryPolicy.cooldownMs,
							elapsedMs: props.result.elapsedMs,
							kind: 'gateway-recovery',
							leaseReleaseFailureCount: props.result.leaseReleaseFailureCount,
							newBootedAt: props.result.newBootedAt,
							newHostPid: props.result.newHostPid,
							newVmId: props.result.newVmId,
							observedAtMs: props.observedAtMs,
							...(props.result.operationId === undefined
								? {}
								: { operationId: props.result.operationId }),
							reason: props.reason,
							result: 'ok',
							zoneId: props.zoneId,
						} satisfies AgentVmHealthEvent);
			options.healthEventStore.record(event);
			return;
		}

		const event = {
			consecutiveFailures: props.consecutiveFailures,
			cooldownMs: recoveryPolicy.cooldownMs,
			elapsedMs: props.result.elapsedMs,
			errorCode: props.result.errorCode,
			kind: 'gateway-recovery',
			...(props.result.leaseReleaseFailureCount === undefined
				? {}
				: { leaseReleaseFailureCount: props.result.leaseReleaseFailureCount }),
			observedAtMs: props.observedAtMs,
			...(props.result.operationId === undefined ? {} : { operationId: props.result.operationId }),
			reason: props.reason,
			result: 'failed',
			zoneId: props.zoneId,
		} as const;
		if (recoveryAction === 'gateway-vm-restart') {
			if (props.result.oldVmId === undefined) {
				if (!isGatewayRecoveryTimeoutErrorCodeValue(props.result.errorCode)) {
					const malformedRestartEvent = {
						...event,
						action: 'operator-required',
						errorCode: props.result.errorCode,
					} satisfies AgentVmHealthEvent;
					options.healthEventStore.record(malformedRestartEvent);
					return;
				}
				const timeoutEvent = {
					...event,
					action: 'gateway-vm-restart',
					errorCode: props.result.errorCode,
					oldBootedAt: props.result.oldBootedAt,
					oldHostPid: props.result.oldHostPid,
					oldVmId: props.result.oldVmId,
				} satisfies AgentVmHealthEvent;
				options.healthEventStore.record(timeoutEvent);
				return;
			}
			const restartEvent = {
				...event,
				action: 'gateway-vm-restart',
				oldBootedAt: props.result.oldBootedAt,
				oldHostPid: props.result.oldHostPid,
				oldVmId: props.result.oldVmId,
			} satisfies AgentVmHealthEvent;
			options.healthEventStore.record(restartEvent);
			return;
		}
		const nonRestartEvent = {
			...event,
			action: recoveryAction,
		} satisfies AgentVmHealthEvent;
		options.healthEventStore.record(nonRestartEvent);
	};

	const recordGatewayRecoverySuspendedEvent = (props: {
		readonly consecutiveFailedRecoveries: number;
		readonly consecutiveFailures: number;
		readonly observedAtMs: number;
		readonly reason: GatewayVmRecoveryReason;
		readonly action: GatewayRecoveryEventAction;
		readonly zoneId: string;
	}): void => {
		const event = {
			action: props.action,
			consecutiveFailedRecoveries: props.consecutiveFailedRecoveries,
			consecutiveFailures: props.consecutiveFailures,
			cooldownMs: recoveryPolicy.cooldownMs,
			errorCode: 'max-failed-recoveries',
			failedRecoveryResetMs: recoveryPolicy.failedRecoveryResetMs,
			kind: 'gateway-recovery-suspended',
			observedAtMs: props.observedAtMs,
			reason: props.reason,
			result: 'failed',
			zoneId: props.zoneId,
		} satisfies AgentVmHealthEvent;
		options.healthEventStore.record(event);
	};

	const executeGatewayRecoveryDecision = async (props: {
		readonly decision: GatewayVmRecoveryDecision;
		readonly observedAtMs: number;
		readonly recoveryBudgetClass: GatewayVmRecoveryBudgetClass;
		readonly sourceKey?: GatewayVmRecoverySourceKey | undefined;
		readonly suspensionReason: GatewayVmRecoveryReason;
	}): Promise<void> => {
		if (props.decision.kind === 'suspended') {
			if (!props.decision.outwardEscalationRequired) {
				return;
			}
			recordGatewayRecoverySuspendedEvent({
				consecutiveFailedRecoveries: props.decision.consecutiveFailedRecoveries,
				consecutiveFailures: props.decision.consecutiveFailures,
				observedAtMs: props.observedAtMs,
				reason: props.suspensionReason,
				action: 'operator-required',
				zoneId: props.decision.zoneId,
			});
			return;
		}
		if (props.decision.kind !== 'restart') {
			return;
		}
		if (stopped) {
			writeGatewayServiceHealthMonitorLog({
				operation: 'gateway-vm-recovery-while-stopped',
				zoneId: props.decision.zoneId,
			});
			return;
		}

		recoveryTracker.markRecoveryStarted({
			observedAtMs: props.observedAtMs,
			recoveryBudgetClass: props.recoveryBudgetClass,
			zoneId: props.decision.zoneId,
		});
		const recoveryResult = await runRecovery(
			{
				consecutiveFailures: props.decision.consecutiveFailures,
				reason: props.decision.reason,
				...(props.sourceKey === undefined ? {} : { sourceKey: props.sourceKey }),
				zoneId: props.decision.zoneId,
			},
			recoveryActionForBudgetClass(props.recoveryBudgetClass),
		);
		const observedAtMs = options.now();
		recoveryTracker.markRecoveryFinished({
			observedAtMs,
			recoveryBudgetClass: props.recoveryBudgetClass,
			result: budgetResultForRecoveryResult(recoveryResult),
			zoneId: props.decision.zoneId,
		});
		recordGatewayRecoveryEvent({
			consecutiveFailures: props.decision.consecutiveFailures,
			observedAtMs,
			reason: props.decision.reason,
			result: recoveryResult,
			zoneId: props.decision.zoneId,
		});
	};

	const maybeRecoverGatewayVm = async (props: {
		readonly observedAtMs: number;
		readonly reason: GatewayVmRecoveryReason;
		readonly serviceProbeResult: 'failed' | 'ok';
		readonly zoneId: string;
	}): Promise<void> => {
		const recoveryBudgetClass = classifyRecoveryBudgetClass({
			consecutiveFailures: 0,
			reason: props.reason,
			zoneId: props.zoneId,
		});
		const latestControlSessionEvent = latestGatewayControlSessionEvent(props.zoneId);
		const sourceKey = options.resolveGatewayRecoverySourceKey?.({
			latestControlSessionEvent,
			zoneId: props.zoneId,
		});
		const controlSessionSourceAttribution = controlSessionEventBelongsToCurrentSource({
			event: latestControlSessionEvent,
			sourceKey,
			zoneId: props.zoneId,
		});
		if (controlSessionSourceAttribution === 'source-changed' && sourceKey !== undefined) {
			recoveryTracker.recordGatewaySourceChange({ sourceKey, zoneId: props.zoneId });
		}
		const controlSessionObservation =
			props.serviceProbeResult === 'ok' || props.reason === 'gateway-service-unhealthy'
				? controlSessionSourceAttribution === 'current'
					? classifyGatewayControlSessionObservation({
							controlLinkEvent: latestControlSessionEvent,
							nowMs: props.observedAtMs,
							zoneId: props.zoneId,
						})
					: { deathGrace: undefined, result: 'unobserved' as const }
				: { deathGrace: undefined, result: 'unobserved' as const };
		if (props.reason === 'gateway-control-session-unhealthy') {
			const decision = recoveryTracker.recordGatewayControlSessionObservation({
				controlSessionDeathGrace: controlSessionObservation.deathGrace,
				observedAtMs: props.observedAtMs,
				recoveryBudgetClass,
				result: controlSessionObservation.result,
				...(sourceKey === undefined ? {} : { sourceKey }),
				zoneId: props.zoneId,
			});
			const latestEvent = controlSessionObservation.latestEvent;
			if (
				decision.kind !== 'none' ||
				decision.reason !== 'needs-corroboration' ||
				controlSessionObservation.deathGrace !== 'recovery-due' ||
				sourceKey === undefined ||
				latestEvent === undefined ||
				options.recoverDeadControlSession === undefined
			) {
				return;
			}
			const eventKey = `${latestEvent.zoneId}\0${String(latestEvent.observedAtMs)}\0${latestEvent.peerId}`;
			const retryAtMs = controlSessionRecoveryRetryAtMsByEventKey.get(eventKey);
			if (retryAtMs !== undefined && props.observedAtMs < retryAtMs) {
				return;
			}
			controlSessionRecoveryRetryAtMsByEventKey.set(
				eventKey,
				props.observedAtMs + recoveryPolicy.restartTimeoutMs,
			);
			try {
				await runWithRecoveryDeadline(
					options.recoverDeadControlSession({ sourceKey, zoneId: props.zoneId }),
				);
			} catch (error) {
				if (!(error instanceof GatewayRecoveryDeadlineExceededError)) {
					controlSessionRecoveryRetryAtMsByEventKey.delete(eventKey);
				}
				writeGatewayServiceHealthMonitorLog({
					operation: 'gateway-control-session-recovery',
					zoneId: props.zoneId,
				});
			}
			return;
		}
		const controlSessionDecision =
			props.reason === 'gateway-service-unhealthy' &&
			controlSessionObservation.result !== 'unobserved'
				? recoveryTracker.recordGatewayControlSessionObservation({
						controlSessionDeathGrace: controlSessionObservation.deathGrace,
						observedAtMs: props.observedAtMs,
						recoveryBudgetClass,
						result: controlSessionObservation.result,
						...(sourceKey === undefined ? {} : { sourceKey }),
						zoneId: props.zoneId,
					})
				: undefined;
		const decision =
			controlSessionDecision?.kind === 'suspended'
				? controlSessionDecision
				: recoveryTracker.recordGatewayServiceProbe({
						observedAtMs: props.observedAtMs,
						recoveryBudgetClass,
						result: props.serviceProbeResult,
						...(sourceKey === undefined ? {} : { sourceKey }),
						zoneId: props.zoneId,
					});

		await executeGatewayRecoveryDecision({
			decision,
			observedAtMs: props.observedAtMs,
			recoveryBudgetClass,
			...(sourceKey === undefined ? {} : { sourceKey }),
			suspensionReason:
				controlSessionDecision?.kind === 'suspended'
					? 'gateway-control-session-unhealthy'
					: props.reason,
		});
	};

	const maybeRecoverAgentChannelProvider = async (props: {
		readonly observedAtMs: number;
		readonly zoneId: string;
	}): Promise<void> => {
		const latestEvents = latestChannelProviderHealthEvents(props.zoneId);
		if (latestEvents.length === 0) {
			return;
		}
		let selectedDecision:
			| {
					readonly decision: Extract<
						GatewayVmRecoveryDecision,
						{ readonly kind: 'restart' | 'suspended' }
					>;
					readonly eventKey: string;
					readonly reason: GatewayVmRecoveryReason;
					readonly recoveryBudgetClass: GatewayVmRecoveryBudgetClass;
			  }
			| undefined;
		for (const latestEvent of latestEvents) {
			const eventKey = channelProviderEventKey(latestEvent);
			if (recoveredChannelProviderEventKeys.has(eventKey)) {
				continue;
			}
			const recoveryObservation = deriveChannelProviderRecoveryObservation({
				allowRestartWhenUnrecoverable: channelProviderPolicy.restartGatewayOnUnrecoverable,
				event: latestEvent,
				nowMs: props.observedAtMs,
				restartGatewayOnRecoverable: channelProviderPolicy.restartGatewayOnRecoverable,
				staleAfterMs: options.staleAfterMs,
				transitioningTimeoutMs: channelProviderPolicy.transitioningTimeoutMs,
			});
			if (recoveryObservation.kind === 'observe-only') {
				continue;
			}
			const recoveryBudgetClass = classifyRecoveryBudgetClass({
				consecutiveFailures: 0,
				reason: recoveryObservation.reason ?? 'agent-channel-provider-unhealthy',
				zoneId: props.zoneId,
			});
			const decision = recoveryTracker.recordAgentChannelProviderObservation({
				...recoveryObservation.observation,
				recoveryBudgetClass,
			});
			if (decision.kind === 'restart' || decision.kind === 'suspended') {
				selectedDecision = {
					decision,
					eventKey,
					reason: recoveryObservation.reason ?? 'agent-channel-provider-unhealthy',
					recoveryBudgetClass,
				};
				break;
			}
		}
		if (!selectedDecision) {
			return;
		}
		const { decision, reason } = selectedDecision;
		if (decision.kind === 'suspended') {
			if (!decision.outwardEscalationRequired) {
				return;
			}
			recordGatewayRecoverySuspendedEvent({
				consecutiveFailedRecoveries: decision.consecutiveFailedRecoveries,
				consecutiveFailures: decision.consecutiveFailures,
				observedAtMs: props.observedAtMs,
				reason,
				action: 'operator-required',
				zoneId: decision.zoneId,
			});
			return;
		}
		if (stopped) {
			writeGatewayServiceHealthMonitorLog({
				operation: 'gateway-channel-provider-recovery-while-stopped',
				zoneId: decision.zoneId,
			});
			return;
		}

		recoveryTracker.markRecoveryStarted({
			observedAtMs: props.observedAtMs,
			recoveryBudgetClass: selectedDecision.recoveryBudgetClass,
			zoneId: decision.zoneId,
		});
		const recoveryResult = await runRecovery(
			{
				consecutiveFailures: decision.consecutiveFailures,
				reason: decision.reason,
				zoneId: decision.zoneId,
			},
			recoveryActionForBudgetClass(selectedDecision.recoveryBudgetClass),
		);
		const observedAtMs = options.now();
		recoveryTracker.markRecoveryFinished({
			observedAtMs,
			recoveryBudgetClass: selectedDecision.recoveryBudgetClass,
			result: budgetResultForRecoveryResult(recoveryResult),
			zoneId: decision.zoneId,
		});
		recordGatewayRecoveryEvent({
			consecutiveFailures: decision.consecutiveFailures,
			observedAtMs,
			reason: decision.reason,
			result: recoveryResult,
			zoneId: decision.zoneId,
		});
		if (recoveryResult.result === 'ok') {
			recoveredChannelProviderEventKeys.add(selectedDecision.eventKey);
		}
	};

	const tick = async (): Promise<void> => {
		if (runningTick) {
			return await runningTick;
		}
		runningTick = (async () => {
			await Promise.all(
				options.zoneIds.map(async (zoneId) => {
					try {
						const result = await options.probeZoneHealth(zoneId);
						const observedAtMs = options.now();
						const serviceProbeResult = result.ok ? 'ok' : 'failed';
						options.healthEventStore.record({
							kind: 'gateway-service-health',
							observedAtMs,
							path: result.path,
							port: result.port,
							result: serviceProbeResult,
							...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }),
							zoneId: result.zoneId,
						});
						await maybeRecoverGatewayVm({
							observedAtMs,
							reason: 'gateway-service-unhealthy',
							serviceProbeResult,
							zoneId: result.zoneId,
						});
						if (serviceProbeResult === 'ok') {
							await maybeRecoverGatewayVm({
								observedAtMs,
								reason: 'gateway-control-session-unhealthy',
								serviceProbeResult,
								zoneId: result.zoneId,
							});
							await maybeRecoverAgentChannelProvider({
								observedAtMs,
								zoneId: result.zoneId,
							});
						}
					} catch {
						writeGatewayServiceHealthMonitorLog({
							operation: 'gateway-service-health-probe',
							zoneId,
						});
						const observedAtMs = options.now();
						options.healthEventStore.record({
							kind: 'gateway-service-health',
							observedAtMs,
							path: unknownGatewayServiceHealthTarget.path,
							port: unknownGatewayServiceHealthTarget.port,
							result: 'failed',
							zoneId,
						});
						await maybeRecoverGatewayVm({
							observedAtMs,
							reason: 'gateway-service-unhealthy',
							serviceProbeResult: 'failed',
							zoneId,
						});
					}
				}),
			);
		})().finally(() => {
			runningTick = undefined;
		});
		return await runningTick;
	};

	return {
		recoverFromTerminalAttachmentLoss: async (request): Promise<void> => {
			const existingRecovery = runningTerminalAttachmentRecoveryByZoneId.get(request.zoneId);
			if (existingRecovery !== undefined) {
				return await existingRecovery;
			}
			const recovery = (async (): Promise<void> => {
				const observedAtMs = options.now();
				const recoveryBudgetClass = classifyRecoveryBudgetClass({
					consecutiveFailures: recoveryPolicy.consecutiveFailureThreshold,
					reason: 'gateway-service-unhealthy',
					zoneId: request.zoneId,
				});
				const decision = recoveryTracker.requestTerminalGatewayRecovery({
					observedAtMs,
					recoveryBudgetClass,
					result: 'failed',
					sourceKey: request.sourceKey,
					zoneId: request.zoneId,
				});
				await executeGatewayRecoveryDecision({
					decision,
					observedAtMs,
					recoveryBudgetClass,
					sourceKey: request.sourceKey,
					suspensionReason: 'gateway-service-unhealthy',
				});
			})().finally(() => {
				if (runningTerminalAttachmentRecoveryByZoneId.get(request.zoneId) === recovery) {
					runningTerminalAttachmentRecoveryByZoneId.delete(request.zoneId);
				}
			});
			runningTerminalAttachmentRecoveryByZoneId.set(request.zoneId, recovery);
			return await recovery;
		},
		start: () => {
			if (timer) {
				return;
			}
			stopped = false;
			timer = setIntervalImpl(async () => {
				try {
					await tick();
				} catch {
					writeGatewayServiceHealthMonitorLog({
						operation: 'scheduled-gateway-health-tick',
					});
				}
			}, options.intervalMs);
			timer.unref?.();
		},
		stop: async () => {
			stopped = true;
			if (timer) {
				clearIntervalImpl(timer);
				timer = undefined;
			}
			if (runningTick) {
				await runningTick;
			}
			if (runningTerminalAttachmentRecoveryByZoneId.size > 0) {
				await Promise.all(runningTerminalAttachmentRecoveryByZoneId.values());
			}
		},
		tick,
	};
}
