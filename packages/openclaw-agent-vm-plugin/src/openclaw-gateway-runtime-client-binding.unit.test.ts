import type {
	PortalCallRequest,
	PortalCallResult,
	PortalDescribeRequest,
	PortalDescribeResult,
	PortalListRequest,
	PortalListResult,
	PortalSearchRequest,
	PortalSearchResult,
} from '@agent-vm/agent-portal-sdk';
import type { GatewayRuntimePortalRequestOptions } from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import { describe, expect, it } from 'vitest';

import {
	getOpenClawGatewayRuntimeClient,
	publishOpenClawGatewayRuntimeClient,
} from './openclaw-gateway-runtime-client-binding.js';
import type { OpenClawToolPortalClient } from './tool-portal-native-tools.js';

function createToolPortalClient(): OpenClawToolPortalClient {
	return {
		portal: {
			call: async (
				_request: PortalCallRequest,
				_options: GatewayRuntimePortalRequestOptions,
			): Promise<PortalCallResult> => ({ items: [], ok: true }),
			describe: async (
				_request: PortalDescribeRequest,
				_options: GatewayRuntimePortalRequestOptions,
			): Promise<PortalDescribeResult> => ({ items: [], ok: true }),
			list: async (
				_request: PortalListRequest,
				_options: GatewayRuntimePortalRequestOptions,
			): Promise<PortalListResult> => ({ items: [], ok: true }),
			search: async (
				_request: PortalSearchRequest,
				_options: GatewayRuntimePortalRequestOptions,
			): Promise<PortalSearchResult> => ({ items: [], ok: true }),
		},
	};
}

describe('OpenClaw Gateway Runtime client binding', () => {
	it('keeps a newer client published when an older service releases its binding', () => {
		const firstClient = createToolPortalClient();
		const secondClient = createToolPortalClient();
		const releaseFirstClient = publishOpenClawGatewayRuntimeClient(firstClient);
		const releaseSecondClient = publishOpenClawGatewayRuntimeClient(secondClient);

		releaseFirstClient();

		expect(getOpenClawGatewayRuntimeClient()).toBe(secondClient);
		releaseSecondClient();
		expect(getOpenClawGatewayRuntimeClient()).toBeUndefined();
	});
});
