export interface HostedProxyLimits {
	readonly requestBodyBytes: number;
	readonly upstreamResponseBytes: number;
	readonly replyBytes: number;
	readonly batchCalls: number;
	readonly batchConcurrency: number;
}
