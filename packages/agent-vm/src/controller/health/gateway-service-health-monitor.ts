import type {
	AgentVmHealthEvent,
	GatewayRecoveryEventAction,
	GatewayRecoveryTimeoutErrorCode,
} from '@agent-vm/gateway-interface';

import {
	deriveChannelProviderRecoveryObservation,
	type AgentChannelProviderHealthEvent,
} from './channel-provider-recovery-observation.js';
import {
	createGatewayVmRecoveryTracker,
	defaultGatewayVmChannelProviderRecoveryPolicy,
	type GatewayVmAutoRecoveryPolicy,
	type GatewayVmRecoveryBudgetClass,
	type GatewayVmRecoveryDecision,
	type GatewayVmRecoveryObservationResult,
	type GatewayVmRecoveryReason,
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
	start(): void;
	stop(): Promise<void>;
	tick(): Promise<void>;
}

export interface GatewayVmRecoveryRequest {
	readonly consecutiveFailures: number;
	readonly reason: GatewayVmRecoveryReason;
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
	readonly classifyRecoveryBudgetClass?:
		| ((request: ClassifyRecoveryBudgetClassRequest) => GatewayVmRecoveryBudgetClass)
		| undefined;
	readonly gatewayServiceAutoRestart: GatewayVmAutoRecoveryPolicy;
	readonly healthEventStore: HealthEventStore;
	readonly intervalMs: number;
	readonly now: () => number;
	readonly probeZoneHealth: (zoneId: string) => Promise<GatewayServiceHealthProbeResult>;
	readonly recoverGatewayVm?:
		| ((request: GatewayVmRecoveryRequest) => Promise<GatewayVmRecoveryResult>)
		| undefined;
	readonly setIntervalImpl?:
		| ((callback: () => void | Promise<void>, delayMs: number) => NodeJS.Timeout)
		| undefined;
	readonly staleAfterMs: number;
	readonly zoneIds: readonly string[];
}

function writeGatewayServiceHealthMonitorLog(message: string): void {
	process.stderr.write(`[gateway-service-health-monitor] ${message}\n`);
}

const unknownGatewayServiceHealthTarget = {
	path: '(unknown)',
	port: 0,
} as const;

function channelProviderEventKey(event: AgentChannelProviderHealthEvent): string {
	return `${event.zoneId}\0${event.channelProviderId}\0${String(event.observedAtMs)}`;
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

export function createGatewayServiceHealthMonitor(
	options: CreateGatewayServiceHealthMonitorOptions,
): GatewayServiceHealthMonitor {
	const setIntervalImpl = options.setIntervalImpl ?? setInterval;
	const clearIntervalImpl = options.clearIntervalImpl ?? clearInterval;
	const recoveryPolicy = options.gatewayServiceAutoRestart;
	const channelProviderPolicy =
		recoveryPolicy.channelProviderHealth ?? defaultGatewayVmChannelProviderRecoveryPolicy;
	const recoveryTracker = createGatewayVmRecoveryTracker({ policy: recoveryPolicy });
	let timer: NodeJS.Timeout | undefined;
	let runningTick: Promise<void> | undefined;
	const recoveredChannelProviderEventKeys = new Set<string>();
	let stopped = false;

	const classifyRecoveryBudgetClass = (
		request: ClassifyRecoveryBudgetClassRequest,
	): GatewayVmRecoveryBudgetClass => {
		try {
			return options.classifyRecoveryBudgetClass?.(request) ?? 'gateway-vm-restart';
		} catch (error) {
			writeGatewayServiceHealthMonitorLog(
				`recovery budget classification failed for zone '${request.zoneId}': ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return 'gateway-vm-restart';
		}
	};

	const classifyGatewayControlLinkObservation = (props: {
		readonly nowMs: number;
		readonly zoneId: string;
	}): GatewayVmRecoveryObservationResult => {
		const controlLinkEvent = options.healthEventStore
			.listLatestEventsForZone(props.zoneId)
			.find((event): event is AgentVmHealthEvent & { readonly kind: 'gateway-control-link' } => {
				return event.kind === 'gateway-control-link';
			});
		if (!controlLinkEvent) {
			return 'unobserved';
		}
		if (props.nowMs - controlLinkEvent.observedAtMs > options.staleAfterMs) {
			return 'stale';
		}
		return controlLinkEvent.result;
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
		return await options.recoverGatewayVm(request);
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
		const decision =
			props.reason === 'gateway-service-unhealthy'
				? recoveryTracker.recordGatewayServiceProbe({
						observedAtMs: props.observedAtMs,
						recoveryBudgetClass,
						result: props.serviceProbeResult,
						zoneId: props.zoneId,
					})
				: recoveryTracker.recordGatewayControlLinkObservation({
						observedAtMs: props.observedAtMs,
						recoveryBudgetClass,
						result:
							props.serviceProbeResult === 'ok'
								? classifyGatewayControlLinkObservation({
										nowMs: props.observedAtMs,
										zoneId: props.zoneId,
									})
								: 'unobserved',
						zoneId: props.zoneId,
					});

		if (decision.kind === 'suspended') {
			recordGatewayRecoverySuspendedEvent({
				consecutiveFailedRecoveries: decision.consecutiveFailedRecoveries,
				consecutiveFailures: decision.consecutiveFailures,
				observedAtMs: props.observedAtMs,
				reason: props.reason,
				action: recoveryActionForBudgetClass(recoveryBudgetClass),
				zoneId: decision.zoneId,
			});
			return;
		}
		if (decision.kind !== 'restart') {
			return;
		}
		if (stopped) {
			writeGatewayServiceHealthMonitorLog(
				`recovery requested for zone '${decision.zoneId}' but monitor is stopped`,
			);
			return;
		}

		recoveryTracker.markRecoveryStarted({
			observedAtMs: props.observedAtMs,
			recoveryBudgetClass,
			zoneId: decision.zoneId,
		});
		const recoveryResult = await runRecovery(
			{
				consecutiveFailures: decision.consecutiveFailures,
				reason: decision.reason,
				zoneId: decision.zoneId,
			},
			recoveryActionForBudgetClass(recoveryBudgetClass),
		);
		const observedAtMs = options.now();
		recoveryTracker.markRecoveryFinished({
			observedAtMs,
			recoveryBudgetClass,
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
			recordGatewayRecoverySuspendedEvent({
				consecutiveFailedRecoveries: decision.consecutiveFailedRecoveries,
				consecutiveFailures: decision.consecutiveFailures,
				observedAtMs: props.observedAtMs,
				reason,
				action: recoveryActionForBudgetClass(selectedDecision.recoveryBudgetClass),
				zoneId: decision.zoneId,
			});
			return;
		}
		if (stopped) {
			writeGatewayServiceHealthMonitorLog(
				`recovery requested for zone '${decision.zoneId}' but monitor is stopped`,
			);
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
								reason: 'gateway-control-link-unhealthy',
								serviceProbeResult,
								zoneId: result.zoneId,
							});
							await maybeRecoverAgentChannelProvider({
								observedAtMs,
								zoneId: result.zoneId,
							});
						}
					} catch (error) {
						writeGatewayServiceHealthMonitorLog(
							`probe failed for zone '${zoneId}': ${error instanceof Error ? error.message : String(error)}`,
						);
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
		start: () => {
			if (timer) {
				return;
			}
			stopped = false;
			timer = setIntervalImpl(async () => {
				try {
					await tick();
				} catch (error) {
					writeGatewayServiceHealthMonitorLog(
						`scheduled tick failed: ${error instanceof Error ? error.message : String(error)}`,
					);
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
		},
		tick,
	};
}
