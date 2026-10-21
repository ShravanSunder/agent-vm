export interface CallAnalyticsBinding {
	readonly writeDataPoint: (point: {
		readonly indexes: string[];
		readonly blobs: string[];
		readonly doubles: number[];
	}) => void;
}
export type CallOutcome = 'ran' | 'refused' | 'needs approval' | 'failed';
export type CallFailureKind =
	| 'none'
	| 'authorization'
	| 'approval'
	| 'upstream'
	| 'too-large'
	| 'invalid-input';
export interface CallAnalytics {
	readonly organizationId: string;
	readonly organizationName: string;
	readonly agentName: string;
	readonly mode: 'direct' | 'indirect';
	readonly serverName: string;
	readonly toolName: string;
	readonly outcome: CallOutcome;
	readonly failureKind: CallFailureKind;
	readonly durationMs: number;
	readonly requestBytes: number;
	readonly responseBytes: number;
}

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

/** No raw call, token, result, exception or secret is accepted at this boundary. */
export function writeCallAnalytics(props: {
	readonly binding: CallAnalyticsBinding;
	readonly call: CallAnalytics;
	readonly log: (event: { readonly event: 'analytics-write-dropped' }) => void;
}): void {
	const call = props.call;
	try {
		props.binding.writeDataPoint({
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
	} catch {
		props.log({ event: 'analytics-write-dropped' });
	}
}
