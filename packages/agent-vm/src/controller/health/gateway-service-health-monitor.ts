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
	stop(): void;
	tick(): Promise<void>;
}

export interface CreateGatewayServiceHealthMonitorOptions {
	readonly clearIntervalImpl?: (timer: NodeJS.Timeout) => void;
	readonly healthEventStore: HealthEventStore;
	readonly intervalMs: number;
	readonly now: () => number;
	readonly probeZoneHealth: (zoneId: string) => Promise<GatewayServiceHealthProbeResult>;
	readonly setIntervalImpl?: (
		callback: () => void | Promise<void>,
		delayMs: number,
	) => NodeJS.Timeout;
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
	let timer: NodeJS.Timeout | undefined;
	let runningTick: Promise<void> | undefined;

	const tick = async (): Promise<void> => {
		if (runningTick) {
			return await runningTick;
		}
		runningTick = (async () => {
			await Promise.all(
				options.zoneIds.map(async (zoneId) => {
					try {
						const result = await options.probeZoneHealth(zoneId);
						options.healthEventStore.record({
							kind: 'gateway-service-health',
							observedAtMs: options.now(),
							path: result.path,
							port: result.port,
							result: result.ok ? 'ok' : 'failed',
							...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }),
							zoneId: result.zoneId,
						});
					} catch (error) {
						writeGatewayServiceHealthMonitorLog(
							`probe failed for zone '${zoneId}': ${error instanceof Error ? error.message : String(error)}`,
						);
						options.healthEventStore.record({
							kind: 'gateway-service-health',
							observedAtMs: options.now(),
							path: unknownGatewayServiceHealthTarget.path,
							port: unknownGatewayServiceHealthTarget.port,
							result: 'failed',
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
			timer = setIntervalImpl(() => {
				void tick();
			}, options.intervalMs);
			timer.unref?.();
		},
		stop: () => {
			if (!timer) {
				return;
			}
			clearIntervalImpl(timer);
			timer = undefined;
		},
		tick,
	};
}
