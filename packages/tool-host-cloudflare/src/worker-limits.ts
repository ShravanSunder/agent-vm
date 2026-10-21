import type { HostedProxyLimits } from '@agent-collaboration/tool-host-core';

export const workerRequestBodyBytes = 4 * 1024 * 1024;
export const workerUpstreamResponseBytes = 4 * 1024 * 1024;
export const workerReplyBytes = 16 * 1024 * 1024;
export const workerBatchCalls = 50;
export const workerBatchConcurrency = 6;

export const workerHostedProxyLimits: HostedProxyLimits = {
	requestBodyBytes: workerRequestBodyBytes,
	upstreamResponseBytes: workerUpstreamResponseBytes,
	replyBytes: workerReplyBytes,
	batchCalls: workerBatchCalls,
	batchConcurrency: workerBatchConcurrency,
};
export const workerApprovalUsesBytes = 512 * 1024;
