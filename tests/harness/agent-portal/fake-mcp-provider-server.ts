import {
	PortalCallRequestSchema,
	type PortalCallResult,
	PortalCallResultSchema,
	PortalDescribeRequestSchema,
	type PortalDescribeResult,
	PortalDescribeResultSchema,
	type PortalListResult,
	PortalListRequestSchema,
	PortalListResultSchema,
	type PortalSearchResult,
	PortalSearchRequestSchema,
	PortalSearchResultSchema,
	type JsonObject,
	type JsonValue,
} from '@agent-vm/agent-portal-sdk';

export type FakePortalDescribeResult = PortalDescribeResult;
export type FakePortalListResult = PortalListResult;
export type FakePortalSearchResult = PortalSearchResult;

export interface FakeMcpProviderCapability {
	readonly description?: string;
	readonly inputSchema: JsonObject;
	readonly namespace: string;
	readonly name: string;
	readonly value: JsonValue;
}

export interface CreateFakeMcpProviderBackendProps {
	readonly capabilities: readonly FakeMcpProviderCapability[];
}

export interface FakeMcpProviderBackend {
	readonly call: (request: unknown) => Promise<PortalCallResult>;
	readonly describe: (request: unknown) => Promise<FakePortalDescribeResult>;
	readonly list: (request: unknown) => Promise<FakePortalListResult>;
	readonly search: (request: unknown) => Promise<FakePortalSearchResult>;
}

export function createFakeMcpProviderBackend(
	props: CreateFakeMcpProviderBackendProps,
): FakeMcpProviderBackend {
	const capabilities = [...props.capabilities];
	return {
		call: async (request) => createCallResult(capabilities, request),
		describe: async (request) => createDescribeResult(capabilities, request),
		list: async (request) => createListResult(capabilities, request),
		search: async (request) => createSearchResult(capabilities, request),
	};
}

function createListResult(
	capabilities: readonly FakeMcpProviderCapability[],
	request: unknown,
): FakePortalListResult {
	const parsedRequest = PortalListRequestSchema.parse(request);
	return PortalListResultSchema.parse({
		items: parsedRequest.requests.map((itemRequest) => {
			const requestedNamespaces = itemRequest.namespaces ?? [];
			const selectedCapabilities = capabilities.filter(
				(capability) =>
					requestedNamespaces.length === 0 || requestedNamespaces.includes(capability.namespace),
			);
			return {
				id: itemRequest.id,
				status: 'ok',
				value: {
					namespaces: [...new Set(selectedCapabilities.map((capability) => capability.namespace))],
					tools: selectedCapabilities.map((capability) => createCapabilitySummary(capability)),
				},
			};
		}),
		ok: true,
	});
}

function createSearchResult(
	capabilities: readonly FakeMcpProviderCapability[],
	request: unknown,
): FakePortalSearchResult {
	const parsedRequest = PortalSearchRequestSchema.parse(request);
	return PortalSearchResultSchema.parse({
		items: parsedRequest.requests.map((itemRequest) => {
			const query = itemRequest.query?.toLowerCase() ?? '';
			const requestedNamespaces = itemRequest.namespaces ?? [];
			const selectedCapabilities = capabilities.filter((capability) => {
				const namespaceMatches =
					requestedNamespaces.length === 0 || requestedNamespaces.includes(capability.namespace);
				const queryMatches =
					query.length === 0 ||
					capability.namespace.toLowerCase().includes(query) ||
					capability.name.toLowerCase().includes(query) ||
					(capability.description?.toLowerCase().includes(query) ?? false);
				return namespaceMatches && queryMatches;
			});
			return {
				id: itemRequest.id,
				status: 'ok',
				value: {
					tools: selectedCapabilities.map((capability) => createCapabilitySummary(capability)),
				},
			};
		}),
		ok: true,
	});
}

function createDescribeResult(
	capabilities: readonly FakeMcpProviderCapability[],
	request: unknown,
): FakePortalDescribeResult {
	const parsedRequest = PortalDescribeRequestSchema.parse(request);
	return PortalDescribeResultSchema.parse({
		items: parsedRequest.requests.map((itemRequest) => {
			const requestedTools = itemRequest.tools ?? [];
			const selectedCapabilities =
				requestedTools.length === 0
					? capabilities
					: capabilities.filter((capability) =>
							requestedTools.some(
								(tool) => tool.namespace === capability.namespace && tool.name === capability.name,
							),
						);
			return {
				id: itemRequest.id,
				status: 'ok',
				value: {
					tools: selectedCapabilities.map((capability) => createCapabilityDescriptor(capability)),
				},
			};
		}),
		ok: true,
	});
}

function createCallResult(
	capabilities: readonly FakeMcpProviderCapability[],
	request: unknown,
): PortalCallResult {
	const parsedRequest = PortalCallRequestSchema.parse(request);
	const items = parsedRequest.calls.map((callRequest) => {
		const capability = capabilities.find(
			(candidate) =>
				candidate.namespace === callRequest.namespace && candidate.name === callRequest.name,
		);
		if (capability === undefined) {
			return {
				error: {
					code: 'capability_denied',
					message: `Capability ${callRequest.namespace}.${callRequest.name} is not available.`,
					safeDiagnostic: {
						code: 'capability_denied',
						level: 'warn',
						safeMessage: 'Requested capability is not available in this harness.',
					},
				},
				id: callRequest.id,
				status: 'error',
			};
		}
		return {
			id: callRequest.id,
			status: 'ok',
			value: capability.value,
		};
	});
	return PortalCallResultSchema.parse({
		items,
		ok: items.every((item) => item.status === 'ok'),
	});
}

function createCapabilityDescriptor(capability: FakeMcpProviderCapability): JsonObject {
	return {
		annotations: {},
		inputSchema: capability.inputSchema,
		namespace: capability.namespace,
		related: [],
		name: capability.name,
		toolRef: `${capability.namespace}:${capability.name}`,
	};
}

function createCapabilitySummary(capability: FakeMcpProviderCapability): JsonObject {
	return {
		...(capability.description === undefined ? {} : { description: capability.description }),
		input: {
			optional: [],
			propertyCount: 0,
			required: [],
			type:
				typeof capability.inputSchema.type === 'string' ? capability.inputSchema.type : 'object',
		},
		namespace: capability.namespace,
		safety: {},
		name: capability.name,
		toolRef: `${capability.namespace}:${capability.name}`,
	};
}
