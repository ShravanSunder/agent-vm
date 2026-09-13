import { compareUnicodeCodePointStrings, type SafeDiagnostic } from '@agent-vm/agent-portal-sdk';

import {
	mergeToolPortalDescribe,
	type ToolPortalBackendEntry,
	type ToolPortalInvocationOptions,
} from './tool-portal-result-router.js';
import type {
	ToolPortalCatalogDefinition,
	ToolPortalCatalogPreparationResult,
} from './tool-portal-service.js';

function catalogFailureDiagnostics(props: {
	readonly diagnostics?: readonly SafeDiagnostic[] | undefined;
	readonly safeDiagnostic?: SafeDiagnostic | undefined;
}): readonly SafeDiagnostic[] {
	const diagnostics = [
		...(props.diagnostics ?? []),
		...(props.safeDiagnostic === undefined ? [] : [props.safeDiagnostic]),
	];
	return diagnostics.length > 0
		? diagnostics
		: [
				{
					code: 'provider_unavailable',
					level: 'error',
					safeMessage: 'Catalog provider definitions are unavailable.',
				},
			];
}

function catalogToolIdentity(tool: { readonly name: string; readonly namespace: string }): string {
	return JSON.stringify([tool.namespace, tool.name]);
}

export async function prepareManagedCatalogDefinitions(props: {
	readonly entries: readonly ToolPortalBackendEntry<never, ToolPortalInvocationOptions>[];
	readonly operationOptions: ToolPortalInvocationOptions;
}): Promise<ToolPortalCatalogPreparationResult> {
	const diagnostics: SafeDiagnostic[] = [];
	const toolReferences: { readonly name: string; readonly namespace: string }[] = [];
	const listedToolIdentities = new Set<string>();
	for (const entry of props.entries) {
		for (const namespace of [...entry.namespaces].toSorted(compareUnicodeCodePointStrings)) {
			let cursor: string | undefined;
			const seenCursors = new Set<string>();
			let hasNextPage = true;
			while (hasNextPage) {
				// oxlint-disable-next-line no-await-in-loop -- Each cursor is issued by the preceding page.
				const result = await entry.backend.list(
					{
						requests: [
							{
								...(cursor === undefined ? {} : { cursor }),
								id: 'catalog-list',
								limit: 100,
								namespaces: [namespace],
							},
						],
					},
					props.operationOptions,
				);
				const item = result.items[0];
				if (item === undefined || item.status === 'error') {
					diagnostics.push(
						...(item === undefined
							? [
									{
										code: 'provider_unavailable' as const,
										level: 'error' as const,
										safeMessage: 'Catalog listing returned no result.',
									},
								]
							: catalogFailureDiagnostics({
									diagnostics: item.diagnostics,
									safeDiagnostic: item.error.safeDiagnostic,
								})),
					);
					break;
				}
				for (const tool of item.value.tools) {
					const identity = catalogToolIdentity(tool);
					if (tool.namespace !== namespace || listedToolIdentities.has(identity)) {
						diagnostics.push({
							code: 'provider_unavailable',
							level: 'error',
							safeMessage: 'Catalog listing returned inconsistent capability identity.',
						});
						continue;
					}
					listedToolIdentities.add(identity);
					toolReferences.push({ name: tool.name, namespace: tool.namespace });
				}
				const nextCursor = item.value.nextCursor;
				if (nextCursor === undefined) {
					hasNextPage = false;
					continue;
				}
				if (seenCursors.has(nextCursor)) {
					diagnostics.push({
						code: 'provider_unavailable',
						level: 'error',
						safeMessage: 'Catalog listing returned a repeated cursor.',
					});
					break;
				}
				seenCursors.add(nextCursor);
				cursor = nextCursor;
			}
		}
	}
	if (diagnostics.length > 0) return { diagnostics, kind: 'incomplete' };

	const uniqueReferences = [
		...new Map(toolReferences.map((tool) => [catalogToolIdentity(tool), tool] as const)).values(),
	].toSorted((left, right) =>
		compareUnicodeCodePointStrings(catalogToolIdentity(left), catalogToolIdentity(right)),
	);
	const definitions: ToolPortalCatalogDefinition[] = [];
	const describedToolIdentities = new Set<string>();
	const expectedToolIdentities = new Set(uniqueReferences.map(catalogToolIdentity));
	const describeResults = await Promise.all(
		Array.from(
			{ length: Math.ceil(uniqueReferences.length / 100) },
			async (_unused, batchIndex) => {
				const offset = batchIndex * 100;
				const selected = uniqueReferences.slice(offset, offset + 100);
				return await mergeToolPortalDescribe({
					entries: props.entries,
					operationOptions: props.operationOptions,
					request: {
						requests: [
							{
								id: `catalog-describe-${offset}`,
								includeJsonSchema: true,
								includeRelated: false,
								includeTypescriptHelper: false,
								includeZod: false,
								tools: selected,
							},
						],
					},
				});
			},
		),
	);
	for (const result of describeResults) {
		const item = result.items[0];
		if (item === undefined || item.status === 'error') {
			diagnostics.push(
				...(item === undefined
					? [
							{
								code: 'provider_unavailable' as const,
								level: 'error' as const,
								safeMessage: 'Catalog description returned no result.',
							},
						]
					: catalogFailureDiagnostics({
							diagnostics: item.diagnostics,
							safeDiagnostic: item.error.safeDiagnostic,
						})),
			);
			continue;
		}
		for (const tool of item.value.tools) {
			const identity = catalogToolIdentity(tool);
			if (
				tool.inputSchema === undefined ||
				!expectedToolIdentities.has(identity) ||
				describedToolIdentities.has(identity)
			) {
				diagnostics.push({
					code: 'provider_unavailable',
					level: 'error',
					safeMessage: 'Catalog capability input schema is unavailable.',
				});
				continue;
			}
			describedToolIdentities.add(identity);
			definitions.push({
				inputSchema: tool.inputSchema,
				name: tool.name,
				namespace: tool.namespace,
			});
		}
	}
	if (definitions.length !== uniqueReferences.length && diagnostics.length === 0) {
		diagnostics.push({
			code: 'provider_unavailable',
			level: 'error',
			safeMessage: 'Catalog description did not return every listed capability.',
		});
	}
	if (diagnostics.length > 0) {
		return { diagnostics, kind: 'incomplete' };
	}
	return { kind: 'complete', tools: definitions };
}
