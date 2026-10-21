import type { HostedProxyLimits } from '#tool-host-core/request-limits/models/hosted-proxy-limits';
export const testHostedProxyLimits: HostedProxyLimits = {
	requestBodyBytes: 4 * 1024 * 1024,
	upstreamResponseBytes: 4 * 1024 * 1024,
	replyBytes: 16 * 1024 * 1024,
	batchCalls: 50,
	batchConcurrency: 6,
};
