import type { AgentVmHealthEvent } from '@agent-vm/gateway-interface';

import {
	createGatewayVmRecoveryTracker,
	type GatewayVmAutoRecoveryPolicy,
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

export type GatewayVmRecoveryResult =
	| {
			readonly elapsedMs: number;
			readonly leaseReleaseFailureCount: number;
			readonly newBootedAt: string;
			readonly newHostPid: number;
			readonly newVmId: string;
			readonly oldBootedAt: string;
			readonly oldHostPid: number;
			readonly oldVmId: string;
			readonly result: 'ok';
	  }
	| {
			readonly elapsedMs: number;
			readonly errorCode: string;
			readonly leaseReleaseFailureCount?: number | undefined;
			readonly oldBootedAt?: string | undefined;
			readonly oldHostPid?: number | undefined;
			readonly oldVmId?: string | undefined;
			readonly result: 'failed';
	  };

export interface CreateGatewayServiceHealthMonitorOptions {
	readonly clearIntervalImpl?: ((timer: NodeJS.Timeout) => void) | undefined;
	readonly clearTimeoutImpl?: ((timer: NodeJS.Timeout) => void) | undefined;
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
	readonly setTimeoutImpl?: ((callback: () => void, delayMs: number) => NodeJS.Timeout) | undefined;
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

export function createGatewayServiceHealthMonitor(
	options: CreateGatewayServiceHealthMonitorOptions,
): GatewayServiceHealthMonitor {
	const setIntervalImpl = options.setIntervalImpl ?? setInterval;
	const clearIntervalImpl = options.clearIntervalImpl ?? clearInterval;
	const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
	const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
	const recoveryPolicy = options.gatewayServiceAutoRestart;
	const recoveryTracker = createGatewayVmRecoveryTracker({ policy: recoveryPolicy });
	let timer: NodeJS.Timeout | undefined;
	let runningTick: Promise<void> | undefined;
	let stopped = false;

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

	const runRecoveryWithDeadline = async (
		request: GatewayVmRecoveryRequest,
	): Promise<GatewayVmRecoveryResult> => {
		if (!options.recoverGatewayVm) {
			return {
				elapsedMs: 0,
				errorCode: 'recovery-callback-unconfigured',
				result: 'failed',
			};
		}

		let timeout: NodeJS.Timeout | undefined;
		const startedAtMs = options.now();
		try {
			return await Promise.race([
				options.recoverGatewayVm(request),
				new Promise<GatewayVmRecoveryResult>((resolve) => {
					timeout = setTimeoutImpl(() => {
						resolve({
							elapsedMs: options.now() - startedAtMs,
							errorCode: 'recovery-timeout',
							result: 'failed',
						});
					}, recoveryPolicy.restartTimeoutMs);
					timeout.unref?.();
				}),
			]);
		} finally {
			if (timeout) {
				clearTimeoutImpl(timeout);
			}
		}
	};

	const recordGatewayRecoveryEvent = (props: {
		readonly consecutiveFailures: number;
		readonly observedAtMs: number;
		readonly reason: GatewayVmRecoveryReason;
		readonly result: GatewayVmRecoveryResult;
		readonly zoneId: string;
	}): void => {
		if (props.result.result === 'ok') {
			const event = {
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
				reason: props.reason,
				result: 'ok',
				zoneId: props.zoneId,
			} satisfies AgentVmHealthEvent;
			options.healthEventStore.record(event);
			return;
		}

		const event = {
			action: 'gateway-vm-restart',
			consecutiveFailures: props.consecutiveFailures,
			cooldownMs: recoveryPolicy.cooldownMs,
			elapsedMs: props.result.elapsedMs,
			errorCode: props.result.errorCode,
			kind: 'gateway-recovery',
			...(props.result.leaseReleaseFailureCount === undefined
				? {}
				: { leaseReleaseFailureCount: props.result.leaseReleaseFailureCount }),
			observedAtMs: props.observedAtMs,
			oldBootedAt: props.result.oldBootedAt,
			oldHostPid: props.result.oldHostPid,
			oldVmId: props.result.oldVmId,
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
		const decision =
			props.reason === 'gateway-service-unhealthy'
				? recoveryTracker.recordGatewayServiceProbe({
						observedAtMs: props.observedAtMs,
						result: props.serviceProbeResult,
						zoneId: props.zoneId,
					})
				: recoveryTracker.recordGatewayControlLinkObservation({
						observedAtMs: props.observedAtMs,
						result:
							props.serviceProbeResult === 'ok'
								? classifyGatewayControlLinkObservation({
										nowMs: props.observedAtMs,
										zoneId: props.zoneId,
									})
								: 'unobserved',
						zoneId: props.zoneId,
					});

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
			zoneId: decision.zoneId,
		});
		const recoveryResult = await runRecoveryWithDeadline({
			consecutiveFailures: decision.consecutiveFailures,
			reason: decision.reason,
			zoneId: decision.zoneId,
		});
		const observedAtMs = options.now();
		recoveryTracker.markRecoveryFinished({
			observedAtMs,
			result: recoveryResult.result,
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
