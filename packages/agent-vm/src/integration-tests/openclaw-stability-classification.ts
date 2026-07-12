import type { AgentVmHealthEvent } from '@agent-vm/gateway-contracts';

export interface OpenClawStabilityEventScanOptions {
	readonly allowedTransientFailuresPerKind?: number;
	readonly events: readonly AgentVmHealthEvent[];
	readonly readyAtMs: number;
}

export interface OpenClawStabilityEventScan {
	readonly failures: readonly string[];
	readonly gatewayControlSessionFailureEvents: number;
	readonly gatewayRecoveryEvents: number;
	readonly gatewayRecoverySuspendedEvents: number;
	readonly gatewayServiceFailureEvents: number;
	readonly scannedEvents: number;
}

export interface OpenClawStabilityLogScan {
	readonly benignUndiciMentions: number;
	readonly crashSignatureMatches: number;
	readonly failures: readonly string[];
}

export function scanOpenClawStabilityEvents(
	options: OpenClawStabilityEventScanOptions,
): OpenClawStabilityEventScan {
	const allowedTransientFailuresPerKind = options.allowedTransientFailuresPerKind ?? 1;
	const postReadinessEvents = options.events.filter(
		(event) => event.observedAtMs > options.readyAtMs,
	);
	const gatewayRecoveryEvents = postReadinessEvents.filter(
		(event) => event.kind === 'gateway-recovery',
	).length;
	const gatewayRecoverySuspendedEvents = postReadinessEvents.filter(
		(event) => event.kind === 'gateway-recovery-suspended',
	).length;
	const gatewayServiceFailureEvents = postReadinessEvents.filter(
		(event) => event.kind === 'gateway-service-health' && event.result !== 'ok',
	).length;
	const gatewayControlSessionFailureEvents = postReadinessEvents.filter(
		(event) => event.kind === 'gateway-control-session' && event.result !== 'ok',
	).length;
	const failures: string[] = [];
	if (gatewayRecoveryEvents > 0) {
		failures.push('gateway-recovery event observed after readiness');
	}
	if (gatewayRecoverySuspendedEvents > 0) {
		failures.push('gateway-recovery-suspended event observed after readiness');
	}
	if (gatewayServiceFailureEvents > allowedTransientFailuresPerKind) {
		failures.push(
			`gateway-service-health had ${String(gatewayServiceFailureEvents)} non-ok events after readiness`,
		);
	}
	if (gatewayControlSessionFailureEvents > allowedTransientFailuresPerKind) {
		failures.push(
			`gateway-control-session had ${String(gatewayControlSessionFailureEvents)} non-ok events after readiness`,
		);
	}
	return {
		failures,
		gatewayControlSessionFailureEvents,
		gatewayRecoveryEvents,
		gatewayRecoverySuspendedEvents,
		gatewayServiceFailureEvents,
		scannedEvents: postReadinessEvents.length,
	};
}

function countLineMatches(logText: string, matches: (line: string) => boolean): number {
	return logText.split('\n').filter(matches).length;
}

export function scanOpenClawStabilityLogs(logText: string): OpenClawStabilityLogScan {
	const nodeAssertionCrashMatches = countLineMatches(
		logText,
		(line) =>
			line.includes('assert(!this.paused)') || line.includes('AssertionError [ERR_ASSERTION]'),
	);
	const supervisorChildExitMatches = countLineMatches(logText, (line) =>
		line.includes('gateway-supervisor: openclaw gateway exited'),
	);
	const supervisorRestartLimitMatches = countLineMatches(logText, (line) =>
		line.includes('gateway-supervisor: restart limit exceeded'),
	);
	const resetBurstMatches = countLineMatches(logText, (line) =>
		/ECONNRESET.*(burst|threshold)|(?:burst|threshold).*ECONNRESET/u.test(line),
	);
	const benignUndiciMentions = countLineMatches(
		logText,
		(line) =>
			line.includes('undici') &&
			!/(assert|AssertionError|socket|parser|exited|ECONNRESET|process)/iu.test(line),
	);
	const failures: string[] = [];
	if (supervisorChildExitMatches > 0) {
		failures.push('gateway-supervisor child exit signature found in logs');
	}
	if (supervisorRestartLimitMatches > 0) {
		failures.push('gateway-supervisor restart-limit signature found in logs');
	}
	if (nodeAssertionCrashMatches > 0) {
		failures.push('Node assertion crash signature found in logs');
	}
	if (resetBurstMatches > 0) {
		failures.push('ECONNRESET burst signature found in logs');
	}
	return {
		benignUndiciMentions,
		crashSignatureMatches:
			nodeAssertionCrashMatches +
			supervisorChildExitMatches +
			supervisorRestartLimitMatches +
			resetBurstMatches,
		failures,
	};
}
