import type { PortalCallResult } from '@agent-vm/agent-portal-sdk';

import type {
	FakeMcpProviderBackend,
	FakePortalDescribeResult,
	FakePortalListResult,
	FakePortalSearchResult,
} from './fake-mcp-provider-server.js';

export interface CreateFakeToolPortalControllerProps {
	readonly providerBackend: FakeMcpProviderBackend;
}

export interface FakeToolPortalController {
	readonly call: (request: unknown) => Promise<PortalCallResult>;
	readonly describe: (request: unknown) => Promise<FakePortalDescribeResult>;
	readonly list: (request: unknown) => Promise<FakePortalListResult>;
	readonly search: (request: unknown) => Promise<FakePortalSearchResult>;
}

export function createFakeToolPortalController(
	props: CreateFakeToolPortalControllerProps,
): FakeToolPortalController {
	return {
		call: (request) => props.providerBackend.call(request),
		describe: (request) => props.providerBackend.describe(request),
		list: (request) => props.providerBackend.list(request),
		search: (request) => props.providerBackend.search(request),
	};
}
