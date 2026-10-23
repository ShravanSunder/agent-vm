import type { AnalyticsSink, CallAnalytics } from '@agent-collaboration/tool-host-core';

export type CallAnalyticsBinding = Readonly<
	Pick<ToolPortalWorkerEnv['CALL_ANALYTICS'], 'writeDataPoint'>
>;

/** Truncate encoded bytes without splitting a Unicode code point. */
export function analyticsText(value: string): string {
	const encoder = new TextEncoder();
	let output = '';
	let bytes = 0;
	for (const character of value) {
		const nextBytes = encoder.encode(character).byteLength;
		if (bytes + nextBytes > 256) break;
		output += character;
		bytes += nextBytes;
	}
	return output;
}

/** Encode semantic events only at the Analytics Engine boundary. */
export function createAnalyticsEngineSink(binding: CallAnalyticsBinding): AnalyticsSink {
	return {
		write: (call: CallAnalytics): void => {
			binding.writeDataPoint({
				indexes: [call.organizationId],
				blobs: [
					call.organizationName,
					call.agentName,
					call.mode,
					call.serverName,
					call.toolName,
					call.outcome,
					call.failureKind,
					'no',
				].map(analyticsText),
				doubles: [call.durationMs, call.requestBytes, call.responseBytes],
			});
		},
	};
}
