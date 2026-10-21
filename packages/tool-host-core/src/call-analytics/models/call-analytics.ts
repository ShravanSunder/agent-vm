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

export interface AnalyticsSink {
	readonly write: (call: CallAnalytics) => void;
}
