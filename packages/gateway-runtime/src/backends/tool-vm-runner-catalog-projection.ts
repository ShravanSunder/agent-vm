import type {
	CapabilityDescriptor,
	CapabilitySearchMatch,
	PortalDescribeRequest,
	PortalDescribeResult,
	PortalListRequest,
	PortalListResult,
	PortalSearchRequest,
	PortalSearchResult,
} from '@agent-vm/agent-portal-sdk';

import type {
	GatewayRuntimeToolVmRunnerCapabilityCatalogEntry,
	GatewayRuntimeToolVmRunnerProfileCapabilityCatalog,
} from './tool-vm-runner-backend-port.js';

function selectedCatalogEntries(props: {
	readonly catalog: GatewayRuntimeToolVmRunnerProfileCapabilityCatalog;
	readonly namespaces?: readonly string[];
	readonly refs?: readonly string[];
	readonly tools?: readonly { readonly name: string; readonly namespace: string }[];
}): readonly GatewayRuntimeToolVmRunnerCapabilityCatalogEntry[] {
	return props.catalog.filter((entry) => {
		if (props.namespaces !== undefined && !props.namespaces.includes(entry.summary.namespace)) {
			return false;
		}
		if (props.refs !== undefined && !props.refs.includes(entry.summary.toolRef)) return false;
		return (
			props.tools === undefined ||
			props.tools.some(
				(tool) => tool.namespace === entry.summary.namespace && tool.name === entry.summary.name,
			)
		);
	});
}

export function listToolVmRunnerCatalog(
	request: PortalListRequest,
	catalog: GatewayRuntimeToolVmRunnerProfileCapabilityCatalog,
): PortalListResult {
	const items = request.requests.map((requestItem): PortalListResult['items'][number] => {
		const entries = selectedCatalogEntries({
			catalog,
			...(requestItem.namespaces === undefined ? {} : { namespaces: requestItem.namespaces }),
			...(requestItem.refs === undefined ? {} : { refs: requestItem.refs }),
			...(requestItem.tools === undefined ? {} : { tools: requestItem.tools }),
		});
		const cursor = Number.parseInt(requestItem.cursor ?? '0', 10);
		const page = entries.slice(cursor, cursor + requestItem.limit);
		const nextOffset = cursor + page.length;
		return {
			id: requestItem.id,
			status: 'ok',
			value: {
				namespaces: [...new Set(page.map((entry) => entry.summary.namespace))],
				...(nextOffset < entries.length ? { nextCursor: String(nextOffset) } : {}),
				tools: page.map((entry) => entry.summary),
			},
		};
	});
	return { items, ok: true };
}

function searchMatchFromCatalogEntry(
	entry: GatewayRuntimeToolVmRunnerCapabilityCatalogEntry,
	schemaDetail: PortalSearchRequest['requests'][number]['schemaDetail'],
): CapabilitySearchMatch {
	return {
		...entry.summary,
		...(schemaDetail === 'full' && entry.descriptor.inputSchema !== undefined
			? { inputSchema: entry.descriptor.inputSchema }
			: {}),
		...(schemaDetail === 'full' && entry.descriptor.outputSchema !== undefined
			? { outputSchema: entry.descriptor.outputSchema }
			: {}),
	};
}

export function searchToolVmRunnerCatalog(
	request: PortalSearchRequest,
	catalog: GatewayRuntimeToolVmRunnerProfileCapabilityCatalog,
): PortalSearchResult {
	const items = request.requests.map((requestItem): PortalSearchResult['items'][number] => {
		const normalizedQuery = requestItem.query?.trim().toLocaleLowerCase() ?? '';
		const entries = selectedCatalogEntries({
			catalog,
			...(requestItem.namespaces === undefined ? {} : { namespaces: requestItem.namespaces }),
		}).filter((entry) => {
			if (normalizedQuery.length === 0) return true;
			return [
				entry.summary.description ?? '',
				entry.summary.name,
				entry.summary.namespace,
				entry.summary.title ?? '',
				entry.summary.toolRef,
			]
				.join('\n')
				.toLocaleLowerCase()
				.includes(normalizedQuery);
		});
		return {
			id: requestItem.id,
			status: 'ok',
			value: {
				tools: entries
					.slice(0, requestItem.limit)
					.map((entry) => searchMatchFromCatalogEntry(entry, requestItem.schemaDetail)),
			},
		};
	});
	return { items, ok: true };
}

function descriptorForRequest(
	descriptor: CapabilityDescriptor,
	requestItem: PortalDescribeRequest['requests'][number],
): CapabilityDescriptor {
	return {
		annotations: descriptor.annotations,
		...(requestItem.includeJsonSchema && descriptor.inputSchema !== undefined
			? { inputSchema: descriptor.inputSchema }
			: {}),
		name: descriptor.name,
		namespace: descriptor.namespace,
		...(requestItem.includeJsonSchema && descriptor.outputSchema !== undefined
			? { outputSchema: descriptor.outputSchema }
			: {}),
		related: requestItem.includeRelated ? descriptor.related : [],
		...(descriptor.schemaHint === undefined ? {} : { schemaHint: descriptor.schemaHint }),
		toolRef: descriptor.toolRef,
		...(requestItem.includeTypescriptHelper && descriptor.typescriptHelper !== undefined
			? { typescriptHelper: descriptor.typescriptHelper }
			: {}),
		...(requestItem.includeZod && descriptor.zod !== undefined ? { zod: descriptor.zod } : {}),
	};
}

export function describeToolVmRunnerCatalog(
	request: PortalDescribeRequest,
	catalog: GatewayRuntimeToolVmRunnerProfileCapabilityCatalog,
): PortalDescribeResult {
	const items = request.requests.map((requestItem): PortalDescribeResult['items'][number] => ({
		id: requestItem.id,
		status: 'ok',
		value: {
			tools: selectedCatalogEntries({
				catalog,
				...(requestItem.refs === undefined ? {} : { refs: requestItem.refs }),
				...(requestItem.tools === undefined ? {} : { tools: requestItem.tools }),
			}).map((entry) => descriptorForRequest(entry.descriptor, requestItem)),
		},
	}));
	return { items, ok: true };
}
