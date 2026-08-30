import { randomUUID } from 'node:crypto';

import {
	PortalCallResultSchema,
	compareUnicodeCodePointStrings,
	compactCapabilitySummaryDescription,
	type EffectiveNamespaceDiscovery,
	type CapabilityDiscoveryMetadata,
	type PortalCallRequest,
	type PortalCallResult,
	type PortalBackendDescribeResult,
	PortalBackendDescribeResultSchema,
	type PortalBackendListResult,
	PortalBackendListResultSchema,
	type PortalBackendSearchResult,
	PortalBackendSearchResultSchema,
	type PortalDescribeRequest,
	type PortalDescribeResult,
	PortalDescribeResultSchema,
	type PortalListRequest,
	type PortalListResult,
	PortalListResultSchema,
	type PortalSearchRequest,
	type PortalSearchResult,
	PortalSearchResultSchema,
	type SafeDiagnostic,
} from '@agent-vm/agent-portal-sdk';
import type {
	GatewayRuntimePortalSurfaceClass,
	GatewayRuntimeTrustedInvocationContext,
} from '@agent-vm/gateway-control-contracts';

export interface ToolPortalInvocationOptions {
	readonly signal?: AbortSignal;
	readonly surfaceClass: GatewayRuntimePortalSurfaceClass;
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
}

interface ToolPortalResultRouterBackendPort<
	TCallOptions = ToolPortalInvocationOptions,
	TReadOptions = TCallOptions,
> {
	readonly call: (request: PortalCallRequest, options: TCallOptions) => Promise<PortalCallResult>;
	readonly describe: (
		request: PortalDescribeRequest,
		options: TReadOptions,
	) => Promise<PortalBackendDescribeResult>;
	readonly list: (
		request: PortalListRequest,
		options: TReadOptions,
	) => Promise<PortalBackendListResult>;
	readonly search: (
		request: PortalSearchRequest,
		options: TReadOptions,
	) => Promise<PortalBackendSearchResult>;
}

export interface ToolPortalBackendEntry<
	TCallOptions = ToolPortalInvocationOptions,
	TReadOptions = TCallOptions,
> {
	readonly backend: ToolPortalResultRouterBackendPort<TCallOptions, TReadOptions>;
	readonly capabilityMetadata?:
		| ((props: {
				readonly name: string;
				readonly namespace: string;
		  }) => CapabilityDiscoveryMetadata | undefined)
		| undefined;
	readonly namespaceDiscovery: readonly EffectiveNamespaceDiscovery[];
	readonly namespaces: ReadonlySet<string>;
}

function projectCapabilityMetadata<
	TCallOptions,
	TReadOptions,
	TCapability extends { readonly name: string; readonly namespace: string },
>(
	entries: readonly ToolPortalBackendEntry<TCallOptions, TReadOptions>[],
	capability: TCapability,
): TCapability & Partial<CapabilityDiscoveryMetadata> {
	const entry = entries.find((candidate) => candidate.namespaces.has(capability.namespace));
	const metadata = entry?.capabilityMetadata?.({
		name: capability.name,
		namespace: capability.namespace,
	});
	return metadata === undefined ? capability : { ...capability, ...metadata };
}

function capabilityDeniedItem(props: {
	readonly id: string;
	readonly namespace: string;
	readonly name: string;
	readonly operationId: string;
	readonly owningGeneration: string;
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
		operationId: props.operationId,
		outcome: {
			certainty: 'proven',
			kind: 'not-dispatched',
			retryClass: 'safe-before-dispatch',
		},
		owningGeneration: props.owningGeneration,
		status: 'error',
	};
}

function executionFailedItem(props: {
	readonly id: string;
	readonly namespace: string;
	readonly name: string;
	readonly operationId: string;
	readonly owningGeneration: string;
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
		operationId: props.operationId,
		outcome: {
			certainty: 'side-effects-and-termination-unknown',
			kind: 'ambiguous',
			retryClass: 'forbidden',
		},
		owningGeneration: props.owningGeneration,
		status: 'error',
	};
}

export async function routeToolPortalCall<TCallOptions, TReadOptions = TCallOptions>(props: {
	readonly entries: readonly ToolPortalBackendEntry<TCallOptions, TReadOptions>[];
	readonly operationOptions: TCallOptions;
	readonly owningGeneration: string;
	readonly request: PortalCallRequest;
}): Promise<PortalCallResult> {
	const itemsById = new Map<string, PortalCallResult['items'][number]>();
	const operationIdsByCallId = new Map(props.request.calls.map((call) => [call.id, randomUUID()]));
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
					props.operationOptions,
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
		const common = {
			id: call.id,
			name: call.name,
			namespace: call.namespace,
			operationId: operationIdsByCallId.get(call.id) ?? randomUUID(),
			owningGeneration: props.owningGeneration,
		};
		return matchedBackend ? executionFailedItem(common) : capabilityDeniedItem(common);
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

type RequestedNamespaceSelection =
	| { readonly kind: 'all' }
	| { readonly kind: 'selected'; readonly namespaces: ReadonlySet<string> };

function requestedListNamespaceSelection(
	requestItem: PortalListRequest['requests'][number],
): RequestedNamespaceSelection {
	const requestedNamespaces = [
		...(requestItem.namespaces ?? []),
		...(requestItem.tools ?? []).map((tool) => tool.namespace),
	];
	return requestedNamespaces.length === 0
		? { kind: 'all' }
		: { kind: 'selected', namespaces: new Set(requestedNamespaces) };
}

function requestedSearchNamespaceSelection(
	requestItem: PortalSearchRequest['requests'][number],
): RequestedNamespaceSelection {
	return requestItem.namespaces === undefined || requestItem.namespaces.length === 0
		? { kind: 'all' }
		: { kind: 'selected', namespaces: new Set(requestItem.namespaces) };
}

function requestedDescribeNamespaceSelection(
	requestItem: PortalDescribeRequest['requests'][number],
): RequestedNamespaceSelection {
	return requestItem.tools === undefined
		? { kind: 'all' }
		: {
				kind: 'selected',
				namespaces: new Set(requestItem.tools.map((tool) => tool.namespace)),
			};
}

function backendEntryMatchesNamespaceSelection(
	entry: { readonly namespaces: ReadonlySet<string> },
	selection: RequestedNamespaceSelection,
): boolean {
	return (
		selection.kind === 'all' ||
		[...selection.namespaces].some((namespace) => entry.namespaces.has(namespace))
	);
}

function filterToolsToRequestedNamespaces<TTool extends { readonly namespace: string }>(
	tools: readonly TTool[],
	selection: RequestedNamespaceSelection,
): readonly TTool[] {
	return selection.kind === 'all'
		? tools
		: tools.filter((tool) => selection.namespaces.has(tool.namespace));
}

function namespaceDiscoveryForRepresentedNamespaces<TCallOptions, TReadOptions>(props: {
	readonly entries: readonly ToolPortalBackendEntry<TCallOptions, TReadOptions>[];
	readonly representedNamespaces: ReadonlySet<string>;
}): readonly EffectiveNamespaceDiscovery[] {
	return props.entries
		.flatMap((entry) => entry.namespaceDiscovery)
		.filter((entry) => props.representedNamespaces.has(entry.namespace))
		.toSorted((left, right) => compareUnicodeCodePointStrings(left.namespace, right.namespace));
}

export async function mergeToolPortalList<TCallOptions, TReadOptions>(props: {
	readonly entries: readonly ToolPortalBackendEntry<TCallOptions, TReadOptions>[];
	readonly operationOptions: TReadOptions;
	readonly request: PortalListRequest;
}): Promise<PortalListResult> {
	const entryResults = await Promise.all(
		props.entries.map(async (entry) => {
			const requests = props.request.requests.filter((requestItem) =>
				backendEntryMatchesNamespaceSelection(entry, requestedListNamespaceSelection(requestItem)),
			);
			if (requests.length === 0) return null;
			const request: PortalListRequest = {
				...(props.request.requestId === undefined ? {} : { requestId: props.request.requestId }),
				requests,
			};
			return {
				entry,
				result: PortalBackendListResultSchema.parse(
					await entry.backend.list(request, props.operationOptions),
				),
			};
		}),
	);
	const admittedEntryResults = entryResults.filter(
		(entryResult): entryResult is NonNullable<typeof entryResult> => entryResult !== null,
	);
	const items = props.request.requests.map((requestItem) => {
		const namespaceSelection = requestedListNamespaceSelection(requestItem);
		const backendItems = admittedEntryResults
			.filter(({ entry }) => backendEntryMatchesNamespaceSelection(entry, namespaceSelection))
			.map(({ result }) => itemById(result).get(requestItem.id))
			.filter((item): item is PortalBackendListResult['items'][number] => item !== undefined);
		const firstErrorItem = backendItems.find(
			(
				item,
			): item is Extract<PortalBackendListResult['items'][number], { readonly status: 'error' }> =>
				item.status === 'error',
		);
		const diagnostics = mergedItemDiagnostics(backendItems);
		if (firstErrorItem !== undefined) {
			return {
				...(diagnostics.length > 0 ? { diagnostics } : {}),
				error: firstErrorItem.error,
				id: requestItem.id,
				status: 'error' as const,
			};
		}
		const okItems = backendItems.filter(
			(
				item,
			): item is Extract<PortalBackendListResult['items'][number], { readonly status: 'ok' }> =>
				item.status === 'ok',
		);
		const namespaces = [
			...new Set(
				okItems
					.flatMap((item) => item.value.namespaces)
					.filter(
						(namespace) =>
							namespaceSelection.kind === 'all' || namespaceSelection.namespaces.has(namespace),
					),
			),
		].toSorted();
		return {
			...(diagnostics.length > 0 ? { diagnostics } : {}),
			id: requestItem.id,
			status: 'ok' as const,
			value: {
				namespaceDiscovery: namespaceDiscoveryForRepresentedNamespaces({
					entries: props.entries,
					representedNamespaces: new Set(namespaces),
				}),
				namespaces,
				tools: filterToolsToRequestedNamespaces(
					okItems.flatMap((item) => item.value.tools),
					namespaceSelection,
				).map((tool) =>
					compactCapabilitySummaryDescription(projectCapabilityMetadata(props.entries, tool)),
				),
			},
		};
	});
	const results = admittedEntryResults.map(({ result }) => result);
	const diagnostics = mergedResultDiagnostics(results);
	const auditCorrelationId = firstAuditCorrelationId(results);
	return PortalListResultSchema.parse({
		...(auditCorrelationId === undefined ? {} : { auditCorrelationId }),
		...(diagnostics.length > 0 ? { diagnostics } : {}),
		items,
		ok: items.every((item) => item.status === 'ok'),
	});
}

export async function mergeToolPortalSearch<TCallOptions, TReadOptions>(props: {
	readonly entries: readonly ToolPortalBackendEntry<TCallOptions, TReadOptions>[];
	readonly operationOptions: TReadOptions;
	readonly request: PortalSearchRequest;
}): Promise<PortalSearchResult> {
	const entryResults = await Promise.all(
		props.entries.map(async (entry) => {
			const requests = props.request.requests.filter((requestItem) =>
				backendEntryMatchesNamespaceSelection(
					entry,
					requestedSearchNamespaceSelection(requestItem),
				),
			);
			if (requests.length === 0) return null;
			const request: PortalSearchRequest = {
				...(props.request.requestId === undefined ? {} : { requestId: props.request.requestId }),
				requests,
			};
			return {
				entry,
				result: PortalBackendSearchResultSchema.parse(
					await entry.backend.search(request, props.operationOptions),
				),
			};
		}),
	);
	const admittedEntryResults = entryResults.filter(
		(entryResult): entryResult is NonNullable<typeof entryResult> => entryResult !== null,
	);
	const items = props.request.requests.map((requestItem) => {
		const namespaceSelection = requestedSearchNamespaceSelection(requestItem);
		const backendItems = admittedEntryResults
			.filter(({ entry }) => backendEntryMatchesNamespaceSelection(entry, namespaceSelection))
			.map(({ result }) => itemById(result).get(requestItem.id))
			.filter((item): item is PortalBackendSearchResult['items'][number] => item !== undefined);
		const firstErrorItem = backendItems.find(
			(
				item,
			): item is Extract<
				PortalBackendSearchResult['items'][number],
				{ readonly status: 'error' }
			> => item.status === 'error',
		);
		const diagnostics = mergedItemDiagnostics(backendItems);
		if (firstErrorItem !== undefined) {
			return {
				...(diagnostics.length > 0 ? { diagnostics } : {}),
				error: firstErrorItem.error,
				id: requestItem.id,
				status: 'error' as const,
			};
		}
		const okItems = backendItems.filter(
			(
				item,
			): item is Extract<PortalBackendSearchResult['items'][number], { readonly status: 'ok' }> =>
				item.status === 'ok',
		);
		const tools = filterToolsToRequestedNamespaces(
			okItems.flatMap((item) => item.value.tools),
			namespaceSelection,
		).map((tool) =>
			compactCapabilitySummaryDescription(projectCapabilityMetadata(props.entries, tool)),
		);
		return {
			...(diagnostics.length > 0 ? { diagnostics } : {}),
			id: requestItem.id,
			status: 'ok' as const,
			value: {
				namespaceDiscovery: namespaceDiscoveryForRepresentedNamespaces({
					entries: props.entries,
					representedNamespaces: new Set(tools.map((tool) => tool.namespace)),
				}),
				tools,
			},
		};
	});
	const results = admittedEntryResults.map(({ result }) => result);
	const diagnostics = mergedResultDiagnostics(results);
	const auditCorrelationId = firstAuditCorrelationId(results);
	return PortalSearchResultSchema.parse({
		...(auditCorrelationId === undefined ? {} : { auditCorrelationId }),
		...(diagnostics.length > 0 ? { diagnostics } : {}),
		items,
		ok: items.every((item) => item.status === 'ok'),
	});
}

export async function mergeToolPortalDescribe<TCallOptions, TReadOptions>(props: {
	readonly entries: readonly ToolPortalBackendEntry<TCallOptions, TReadOptions>[];
	readonly operationOptions: TReadOptions;
	readonly request: PortalDescribeRequest;
}): Promise<PortalDescribeResult> {
	const entryResults = await Promise.all(
		props.entries.map(async (entry) => {
			const requests = props.request.requests.filter((requestItem) =>
				backendEntryMatchesNamespaceSelection(
					entry,
					requestedDescribeNamespaceSelection(requestItem),
				),
			);
			if (requests.length === 0) return null;
			const request: PortalDescribeRequest = {
				...(props.request.requestId === undefined ? {} : { requestId: props.request.requestId }),
				requests,
			};
			return {
				entry,
				result: PortalBackendDescribeResultSchema.parse(
					await entry.backend.describe(request, props.operationOptions),
				),
			};
		}),
	);
	const admittedEntryResults = entryResults.filter(
		(entryResult): entryResult is NonNullable<typeof entryResult> => entryResult !== null,
	);
	const items = props.request.requests.map((requestItem) => {
		const namespaceSelection = requestedDescribeNamespaceSelection(requestItem);
		const backendItems = admittedEntryResults
			.filter(({ entry }) => backendEntryMatchesNamespaceSelection(entry, namespaceSelection))
			.map(({ result }) => itemById(result).get(requestItem.id))
			.filter((item): item is PortalBackendDescribeResult['items'][number] => item !== undefined);
		const firstErrorItem = backendItems.find(
			(
				item,
			): item is Extract<
				PortalBackendDescribeResult['items'][number],
				{ readonly status: 'error' }
			> => item.status === 'error',
		);
		const diagnostics = mergedItemDiagnostics(backendItems);
		if (firstErrorItem !== undefined) {
			return {
				...(diagnostics.length > 0 ? { diagnostics } : {}),
				error: firstErrorItem.error,
				id: requestItem.id,
				status: 'error' as const,
			};
		}
		const okItems = backendItems.filter(
			(
				item,
			): item is Extract<PortalBackendDescribeResult['items'][number], { readonly status: 'ok' }> =>
				item.status === 'ok',
		);
		const tools = filterToolsToRequestedNamespaces(
			okItems.flatMap((item) => item.value.tools),
			namespaceSelection,
		).map((tool) => projectCapabilityMetadata(props.entries, tool));
		return {
			...(diagnostics.length > 0 ? { diagnostics } : {}),
			id: requestItem.id,
			status: 'ok' as const,
			value: {
				namespaceDiscovery: namespaceDiscoveryForRepresentedNamespaces({
					entries: props.entries,
					representedNamespaces: new Set(tools.map((tool) => tool.namespace)),
				}),
				tools,
			},
		};
	});
	const results = admittedEntryResults.map(({ result }) => result);
	const diagnostics = mergedResultDiagnostics(results);
	const auditCorrelationId = firstAuditCorrelationId(results);
	return PortalDescribeResultSchema.parse({
		...(auditCorrelationId === undefined ? {} : { auditCorrelationId }),
		...(diagnostics.length > 0 ? { diagnostics } : {}),
		items,
		ok: items.every((item) => item.status === 'ok'),
	});
}
