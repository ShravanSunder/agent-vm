import {
	compactCapabilitySummaryDescription,
	type EffectiveNamespaceDiscovery,
	type CapabilityDiscoveryMetadata,
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
} from '@agent-collaboration/tool-access/contracts';

export interface ToolPortalDiscoveryBackendPort<TReadOptions> {
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

export interface ToolPortalDiscoveryEntry<TReadOptions> {
	readonly backend: ToolPortalDiscoveryBackendPort<TReadOptions>;
	readonly capabilityMetadata?:
		| ((props: {
				readonly name: string;
				readonly namespace: string;
		  }) => CapabilityDiscoveryMetadata | undefined)
		| undefined;
	readonly namespaceDiscovery: readonly EffectiveNamespaceDiscovery[];
	readonly namespaces: ReadonlySet<string>;
}

function compareUnicodeCodePointStrings(left: string, right: string): number {
	const leftCodePoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
	const rightCodePoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
	const sharedLength = Math.min(leftCodePoints.length, rightCodePoints.length);
	for (let index = 0; index < sharedLength; index += 1) {
		const leftCodePoint = leftCodePoints[index] ?? 0;
		const rightCodePoint = rightCodePoints[index] ?? 0;
		if (leftCodePoint !== rightCodePoint) {
			return leftCodePoint - rightCodePoint;
		}
	}
	return leftCodePoints.length - rightCodePoints.length;
}

function projectCapabilityMetadata<
	TReadOptions,
	TCapability extends { readonly name: string; readonly namespace: string },
>(
	entries: readonly ToolPortalDiscoveryEntry<TReadOptions>[],
	capability: TCapability,
): TCapability & Partial<CapabilityDiscoveryMetadata> {
	const entry = entries.find((candidate) => candidate.namespaces.has(capability.namespace));
	const metadata = entry?.capabilityMetadata?.({
		name: capability.name,
		namespace: capability.namespace,
	});
	return metadata === undefined ? capability : { ...capability, ...metadata };
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

function namespaceDiscoveryForRepresentedNamespaces<TReadOptions>(props: {
	readonly entries: readonly ToolPortalDiscoveryEntry<TReadOptions>[];
	readonly representedNamespaces: ReadonlySet<string>;
}): readonly EffectiveNamespaceDiscovery[] {
	return props.entries
		.flatMap((entry) => entry.namespaceDiscovery)
		.filter((entry) => props.representedNamespaces.has(entry.namespace))
		.toSorted((left, right) => compareUnicodeCodePointStrings(left.namespace, right.namespace));
}

export async function mergeToolPortalList<TReadOptions>(props: {
	readonly entries: readonly ToolPortalDiscoveryEntry<TReadOptions>[];
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
		const nextCursor = okItems.length === 1 ? okItems[0]?.value.nextCursor : undefined;
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
				...(nextCursor === undefined ? {} : { nextCursor }),
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

export async function mergeToolPortalSearch<TReadOptions>(props: {
	readonly entries: readonly ToolPortalDiscoveryEntry<TReadOptions>[];
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

export async function mergeToolPortalDescribe<TReadOptions>(props: {
	readonly entries: readonly ToolPortalDiscoveryEntry<TReadOptions>[];
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
