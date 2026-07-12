import {
	PortalCallRequestSchema,
	type PortalCallRequest,
	type PortalCallResult,
	PortalCallResultSchema,
	type PortalDescribeRequest,
	type PortalDescribeResult,
	PortalDescribeRequestSchema,
	PortalDescribeResultSchema,
	type PortalListRequest,
	type PortalListResult,
	PortalListRequestSchema,
	PortalListResultSchema,
	type PortalSearchRequest,
	type PortalSearchResult,
	PortalSearchRequestSchema,
	PortalSearchResultSchema,
	type SafeDiagnostic,
} from '@agent-vm/agent-portal-sdk';
import {
	createToolPortalControllerHostActionProjection,
	createToolPortalMcpProjection,
	toolPortalConfigSchema,
	type ToolPortalConfig,
	type ToolPortalControllerHostActionProjection,
	type ToolPortalMcpProjection,
} from '@agent-vm/config-contracts';

export interface ToolPortalOperationOptions {
	readonly signal?: AbortSignal;
}

export interface ToolPortalCapabilityBackend {
	readonly call: (
		request: unknown,
		options?: ToolPortalOperationOptions,
	) => Promise<PortalCallResult>;
	readonly describe: (
		request: unknown,
		options?: ToolPortalOperationOptions,
	) => Promise<PortalDescribeResult>;
	readonly list: (
		request: unknown,
		options?: ToolPortalOperationOptions,
	) => Promise<PortalListResult>;
	readonly search: (
		request: unknown,
		options?: ToolPortalOperationOptions,
	) => Promise<PortalSearchResult>;
}

export interface ToolPortalInProcessEntryPoint {
	readonly call: (
		request: unknown,
		options?: ToolPortalOperationOptions,
	) => Promise<PortalCallResult>;
	readonly describe: (
		request: unknown,
		options?: ToolPortalOperationOptions,
	) => Promise<PortalDescribeResult>;
	readonly list: (
		request: unknown,
		options?: ToolPortalOperationOptions,
	) => Promise<PortalListResult>;
	readonly search: (
		request: unknown,
		options?: ToolPortalOperationOptions,
	) => Promise<PortalSearchResult>;
}

export interface CreateToolPortalInProcessEntryPointProps {
	readonly agentId: string;
	readonly config: unknown;
	readonly createControllerHostActionBackend?: (
		projection: ToolPortalControllerHostActionProjection,
		context: { readonly entryPointCacheKey: string },
	) => ToolPortalCapabilityBackend;
	readonly entryPointCacheKey?: string;
	readonly createMcpBackend: (
		projection: ToolPortalMcpProjection,
		context: { readonly entryPointCacheKey: string },
	) => ToolPortalCapabilityBackend;
}

type ToolPortalBackendKind = 'controller_host_action' | 'mcp_provider';

interface ToolPortalBackendEntry {
	readonly backend: ToolPortalCapabilityBackend;
	readonly kind: ToolPortalBackendKind;
	readonly namespaces: ReadonlySet<string>;
}

export function createToolPortalInProcessEntryPoint(
	props: CreateToolPortalInProcessEntryPointProps,
): ToolPortalInProcessEntryPoint {
	const entryPointCacheKey = props.entryPointCacheKey ?? props.agentId;
	const config = toolPortalConfigSchema.parse(props.config);
	assertNoUnsupportedToolVmRunnerBackends(config);
	const mcpProjection = createToolPortalMcpProjection({
		agentId: props.agentId,
		config,
	});
	const mcpBackend = props.createMcpBackend(mcpProjection, { entryPointCacheKey });
	const controllerHostActionProjection = createToolPortalControllerHostActionProjection({
		agentId: props.agentId,
		config,
	});
	const backendEntries: ToolPortalBackendEntry[] = [
		{
			backend: mcpBackend,
			kind: 'mcp_provider',
			namespaces: new Set(Object.keys(mcpProjection.namespaces)),
		},
	];
	if (Object.keys(controllerHostActionProjection.namespaces).length > 0) {
		if (props.createControllerHostActionBackend === undefined) {
			throw new Error('Tool Portal controller_host_action backend is not configured.');
		}
		backendEntries.push({
			backend: props.createControllerHostActionBackend(controllerHostActionProjection, {
				entryPointCacheKey,
			}),
			kind: 'controller_host_action',
			namespaces: new Set(Object.keys(controllerHostActionProjection.namespaces)),
		});
	}

	return {
		call: async (request, options) =>
			await routePortalCall({
				entries: backendEntries,
				options,
				request: PortalCallRequestSchema.parse(request),
			}),
		describe: async (request, options) =>
			await mergePortalDescribe({
				entries: backendEntries,
				options,
				request: PortalDescribeRequestSchema.parse(request),
			}),
		list: async (request, options) =>
			await mergePortalList({
				entries: backendEntries,
				options,
				request: PortalListRequestSchema.parse(request),
			}),
		search: async (request, options) =>
			await mergePortalSearch({
				entries: backendEntries,
				options,
				request: PortalSearchRequestSchema.parse(request),
			}),
	};
}

function assertNoUnsupportedToolVmRunnerBackends(config: ToolPortalConfig): void {
	for (const [profileName, profileConfig] of Object.entries(config.profiles)) {
		for (const [namespace, capabilityPolicy] of Object.entries(profileConfig.capabilities)) {
			if (capabilityPolicy.backend.kind === 'tool_vm_runner') {
				throw new Error(
					`Tool Portal tool_vm_runner backend is not configured for profile "${profileName}" namespace "${namespace}".`,
				);
			}
		}
	}
}

function capabilityDeniedItem(props: {
	readonly id: string;
	readonly namespace: string;
	readonly name: string;
}): PortalCallResult['items'][number] {
	return {
		error: {
			code: 'capability_denied',
			message: `Capability ${props.namespace}.${props.name} is not allowed.`,
			safeDiagnostic: {
				code: 'capability_denied',
				level: 'error',
				safeMessage: 'Capability is not allowed.',
			},
		},
		id: props.id,
		status: 'error',
	};
}

function executionFailedItem(props: {
	readonly id: string;
	readonly namespace: string;
	readonly name: string;
}): PortalCallResult['items'][number] {
	return {
		error: {
			code: 'execution_failed',
			message: `Capability ${props.namespace}.${props.name} did not return a result.`,
			safeDiagnostic: {
				code: 'execution_failed',
				level: 'error',
				safeMessage: 'Capability execution failed.',
			},
		},
		id: props.id,
		status: 'error',
	};
}

async function routePortalCall(props: {
	readonly entries: readonly ToolPortalBackendEntry[];
	readonly options: ToolPortalOperationOptions | undefined;
	readonly request: PortalCallRequest;
}): Promise<PortalCallResult> {
	const itemsById = new Map<string, PortalCallResult['items'][number]>();
	await Promise.all(
		props.entries.map(async (entry) => {
			const calls = props.request.calls.filter((call) => entry.namespaces.has(call.namespace));
			if (calls.length === 0) {
				return;
			}
			const result = PortalCallResultSchema.parse(
				await entry.backend.call(
					{
						...(props.request.requestId === undefined
							? {}
							: { requestId: props.request.requestId }),
						calls,
					},
					props.options,
				),
			);
			for (const item of result.items) {
				itemsById.set(item.id, item);
			}
		}),
	);

	const items = props.request.calls.map((call) => {
		const routedItem = itemsById.get(call.id);
		if (routedItem !== undefined) {
			return routedItem;
		}
		const matchedBackend = props.entries.some((entry) => entry.namespaces.has(call.namespace));
		return matchedBackend
			? executionFailedItem({
					id: call.id,
					namespace: call.namespace,
					name: call.name,
				})
			: capabilityDeniedItem({
					id: call.id,
					namespace: call.namespace,
					name: call.name,
				});
	});
	return PortalCallResultSchema.parse({
		items,
		ok: items.every((item) => item.status === 'ok'),
	});
}

function itemById<TItem extends { readonly id: string }>(result: {
	readonly items: readonly TItem[];
}): ReadonlyMap<string, TItem> {
	return new Map(result.items.map((item) => [item.id, item]));
}

function mergedResultDiagnostics(
	results: readonly { readonly diagnostics?: readonly SafeDiagnostic[] | undefined }[],
): SafeDiagnostic[] {
	return results.flatMap((result) => result.diagnostics ?? []);
}

function mergedItemDiagnostics(
	items: readonly { readonly diagnostics?: readonly SafeDiagnostic[] | undefined }[],
): SafeDiagnostic[] {
	return items.flatMap((item) => item.diagnostics ?? []);
}

function firstAuditCorrelationId(
	results: readonly { readonly auditCorrelationId?: string | undefined }[],
): string | undefined {
	return results.find((result) => result.auditCorrelationId !== undefined)?.auditCorrelationId;
}

async function mergePortalList(props: {
	readonly entries: readonly ToolPortalBackendEntry[];
	readonly options: ToolPortalOperationOptions | undefined;
	readonly request: PortalListRequest;
}): Promise<PortalListResult> {
	const results = await Promise.all(
		props.entries.map(async (entry) =>
			PortalListResultSchema.parse(await entry.backend.list(props.request, props.options)),
		),
	);
	const resultItemsByBackend = results.map(itemById);
	const items = props.request.requests.map((requestItem) => {
		const backendItems = resultItemsByBackend
			.map((itemsById) => itemsById.get(requestItem.id))
			.filter((item): item is PortalListResult['items'][number] => item !== undefined);
		const firstErrorItem = backendItems.find(
			(item): item is Extract<PortalListResult['items'][number], { readonly status: 'error' }> =>
				item.status === 'error',
		);
		const itemDiagnostics = mergedItemDiagnostics(backendItems);
		if (firstErrorItem !== undefined) {
			return {
				...(itemDiagnostics.length > 0 ? { diagnostics: itemDiagnostics } : {}),
				error: firstErrorItem.error,
				id: requestItem.id,
				status: 'error' as const,
			};
		}
		const okItems = backendItems.filter(
			(item): item is Extract<PortalListResult['items'][number], { readonly status: 'ok' }> =>
				item.status === 'ok',
		);
		const namespaces = [...new Set(okItems.flatMap((item) => item.value.namespaces))].toSorted();
		return {
			...(itemDiagnostics.length > 0 ? { diagnostics: itemDiagnostics } : {}),
			id: requestItem.id,
			status: 'ok' as const,
			value: {
				namespaces,
				tools: okItems.flatMap((item) => item.value.tools),
			},
		};
	});
	const diagnostics = mergedResultDiagnostics(results);
	const auditCorrelationId = firstAuditCorrelationId(results);
	return PortalListResultSchema.parse({
		...(auditCorrelationId === undefined ? {} : { auditCorrelationId }),
		...(diagnostics.length > 0 ? { diagnostics } : {}),
		items,
		ok: items.every((item) => item.status === 'ok'),
	});
}

async function mergePortalSearch(props: {
	readonly entries: readonly ToolPortalBackendEntry[];
	readonly options: ToolPortalOperationOptions | undefined;
	readonly request: PortalSearchRequest;
}): Promise<PortalSearchResult> {
	const results = await Promise.all(
		props.entries.map(async (entry) =>
			PortalSearchResultSchema.parse(await entry.backend.search(props.request, props.options)),
		),
	);
	const resultItemsByBackend = results.map(itemById);
	const items = props.request.requests.map((requestItem) => {
		const backendItems = resultItemsByBackend
			.map((itemsById) => itemsById.get(requestItem.id))
			.filter((item): item is PortalSearchResult['items'][number] => item !== undefined);
		const firstErrorItem = backendItems.find(
			(item): item is Extract<PortalSearchResult['items'][number], { readonly status: 'error' }> =>
				item.status === 'error',
		);
		const itemDiagnostics = mergedItemDiagnostics(backendItems);
		if (firstErrorItem !== undefined) {
			return {
				...(itemDiagnostics.length > 0 ? { diagnostics: itemDiagnostics } : {}),
				error: firstErrorItem.error,
				id: requestItem.id,
				status: 'error' as const,
			};
		}
		const okItems = backendItems.filter(
			(item): item is Extract<PortalSearchResult['items'][number], { readonly status: 'ok' }> =>
				item.status === 'ok',
		);
		return {
			...(itemDiagnostics.length > 0 ? { diagnostics: itemDiagnostics } : {}),
			id: requestItem.id,
			status: 'ok' as const,
			value: {
				tools: okItems.flatMap((item) => item.value.tools),
			},
		};
	});
	const diagnostics = mergedResultDiagnostics(results);
	const auditCorrelationId = firstAuditCorrelationId(results);
	return PortalSearchResultSchema.parse({
		...(auditCorrelationId === undefined ? {} : { auditCorrelationId }),
		...(diagnostics.length > 0 ? { diagnostics } : {}),
		items,
		ok: items.every((item) => item.status === 'ok'),
	});
}

async function mergePortalDescribe(props: {
	readonly entries: readonly ToolPortalBackendEntry[];
	readonly options: ToolPortalOperationOptions | undefined;
	readonly request: PortalDescribeRequest;
}): Promise<PortalDescribeResult> {
	const results = await Promise.all(
		props.entries.map(async (entry) =>
			PortalDescribeResultSchema.parse(await entry.backend.describe(props.request, props.options)),
		),
	);
	const resultItemsByBackend = results.map(itemById);
	const items = props.request.requests.map((requestItem) => {
		const backendItems = resultItemsByBackend
			.map((itemsById) => itemsById.get(requestItem.id))
			.filter((item): item is PortalDescribeResult['items'][number] => item !== undefined);
		const firstErrorItem = backendItems.find(
			(
				item,
			): item is Extract<PortalDescribeResult['items'][number], { readonly status: 'error' }> =>
				item.status === 'error',
		);
		const itemDiagnostics = mergedItemDiagnostics(backendItems);
		if (firstErrorItem !== undefined) {
			return {
				...(itemDiagnostics.length > 0 ? { diagnostics: itemDiagnostics } : {}),
				error: firstErrorItem.error,
				id: requestItem.id,
				status: 'error' as const,
			};
		}
		const okItems = backendItems.filter(
			(item): item is Extract<PortalDescribeResult['items'][number], { readonly status: 'ok' }> =>
				item.status === 'ok',
		);
		return {
			...(itemDiagnostics.length > 0 ? { diagnostics: itemDiagnostics } : {}),
			id: requestItem.id,
			status: 'ok' as const,
			value: {
				tools: okItems.flatMap((item) => item.value.tools),
			},
		};
	});
	const diagnostics = mergedResultDiagnostics(results);
	const auditCorrelationId = firstAuditCorrelationId(results);
	return PortalDescribeResultSchema.parse({
		...(auditCorrelationId === undefined ? {} : { auditCorrelationId }),
		...(diagnostics.length > 0 ? { diagnostics } : {}),
		items,
		ok: items.every((item) => item.status === 'ok'),
	});
}
