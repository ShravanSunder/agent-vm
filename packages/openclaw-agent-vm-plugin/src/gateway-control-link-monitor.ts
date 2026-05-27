import { gatewayControlLinkHealthPins, type AgentVmHealthEvent } from '@agent-vm/gateway-interface';

import {
	ControllerRequestPolicyTransportError,
	fetchControllerWithPolicy,
} from './controller-request-policy.js';

export interface GatewayControlLinkMonitor {
	consecutiveFailureCount(): number;
	noteFailureForTest(): void;
	start(): void;
	stop(): void;
	tick(): Promise<void>;
}

export interface CreateGatewayControlLinkMonitorOptions {
	readonly baseIntervalMs: number;
	readonly clearTimeoutImpl?: (timer: NodeJS.Timeout) => void;
	readonly controllerUrl: string;
	readonly fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	readonly maxIntervalMs: number;
	readonly now: () => number;
	readonly setTimeoutImpl?: (
		callback: () => void | Promise<void>,
		delayMs: number,
	) => NodeJS.Timeout;
	readonly writeLog?: (message: string) => void;
	readonly zoneId: string;
}

function defaultWriteLog(message: string): void {
	process.stderr.write(`[gateway-control-link-monitor] ${message}\n`);
}

function joinUrl(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function nextIntervalMs(options: {
	readonly baseIntervalMs: number;
	readonly consecutiveFailureCount: number;
	readonly maxIntervalMs: number;
}): number {
	const multiplier = 2 ** Math.min(options.consecutiveFailureCount, 8);
	return Math.min(options.maxIntervalMs, options.baseIntervalMs * multiplier);
}

export function createGatewayControlLinkMonitor(
	options: CreateGatewayControlLinkMonitorOptions,
): GatewayControlLinkMonitor {
	const fetchImpl = options.fetchImpl ?? fetch;
	const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
	const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
	const writeLog = options.writeLog ?? defaultWriteLog;
	let consecutiveFailureCount = 0;
	let stopped = true;
	let timer: NodeJS.Timeout | undefined;

	const publish = async (event: AgentVmHealthEvent): Promise<void> => {
		const response = await fetchControllerWithPolicy({
			fetchImpl,
			input: joinUrl(
				options.controllerUrl,
				`/zones/${encodeURIComponent(options.zoneId)}/health-events`,
			),
			init: {
				body: JSON.stringify(event),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			},
			operation: 'health-event-publish',
		});
		if (!response.ok) {
			await response.text().catch(() => undefined);
			throw new Error(`health event publish returned HTTP ${String(response.status)}`);
		}
		await response.text().catch(() => undefined);
	};

	const scheduleNext = (): void => {
		if (stopped) {
			return;
		}
		if (timer) {
			return;
		}
		timer = setTimeoutImpl(
			() => {
				timer = undefined;
				void tick().finally(scheduleNext);
			},
			nextIntervalMs({
				baseIntervalMs: options.baseIntervalMs,
				consecutiveFailureCount,
				maxIntervalMs: options.maxIntervalMs,
			}),
		);
		timer.unref?.();
	};

	const tick = async (): Promise<void> => {
		const startedAtMs = options.now();
		let event: AgentVmHealthEvent;
		try {
			const response = await fetchControllerWithPolicy({
				fetchImpl,
				input: joinUrl(options.controllerUrl, gatewayControlLinkHealthPins.path),
				init: { method: 'GET' },
				operation: 'controller-health',
			});
			const ok = response.ok;
			await response.text().catch(() => undefined);
			consecutiveFailureCount = ok ? 0 : consecutiveFailureCount + 1;
			event = {
				controllerHost: gatewayControlLinkHealthPins.controllerHost,
				controllerPort: gatewayControlLinkHealthPins.controllerPort,
				elapsedMs: options.now() - startedAtMs,
				kind: 'gateway-control-link',
				observedAtMs: options.now(),
				operation: gatewayControlLinkHealthPins.operation,
				path: gatewayControlLinkHealthPins.path,
				result: ok ? 'ok' : 'failed',
				zoneId: options.zoneId,
			};
		} catch (error) {
			consecutiveFailureCount += 1;
			event = {
				controllerHost: gatewayControlLinkHealthPins.controllerHost,
				controllerPort: gatewayControlLinkHealthPins.controllerPort,
				elapsedMs: options.now() - startedAtMs,
				kind: 'gateway-control-link',
				observedAtMs: options.now(),
				operation: gatewayControlLinkHealthPins.operation,
				path: gatewayControlLinkHealthPins.path,
				result:
					error instanceof ControllerRequestPolicyTransportError &&
					error.code === 'controller-request-timeout'
						? 'timeout'
						: 'failed',
				zoneId: options.zoneId,
			};
			writeLog(
				`gateway-control-link fetch failed operation=controller-health elapsedMs=${String(event.elapsedMs)} errorCode=${error instanceof ControllerRequestPolicyTransportError ? error.code : 'controller-request-failed'}`,
			);
		}
		try {
			// The agent-vm controller cannot observe this successful gateway-local
			// fetch unless the gateway publishes the health event back over the
			// same control link.
			await publish(event);
		} catch (error) {
			writeLog(
				`gateway-control-link publish failed operation=health-event-publish elapsedMs=${String(event.elapsedMs)} errorCode=${error instanceof ControllerRequestPolicyTransportError ? error.code : 'health-event-publish-failed'} message=${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	return {
		consecutiveFailureCount: () => consecutiveFailureCount,
		noteFailureForTest: () => {
			consecutiveFailureCount += 1;
		},
		start: () => {
			stopped = false;
			scheduleNext();
		},
		stop: () => {
			stopped = true;
			if (!timer) {
				return;
			}
			clearTimeoutImpl(timer);
			timer = undefined;
		},
		tick,
	};
}
