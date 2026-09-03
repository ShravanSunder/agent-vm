import {
	PortalDescribeRequestSchema,
	PortalListRequestSchema,
	PortalSearchRequestSchema,
	type PortalBackendDescribeResult,
	type PortalBackendListResult,
	type PortalBackendSearchResult,
	type PortalCallResult,
} from '@agent-vm/agent-portal-sdk';
import { describe, expect, it } from 'vitest';

import {
	mergeToolPortalDescribe,
	mergeToolPortalList,
	mergeToolPortalSearch,
	type ToolPortalBackendEntry,
} from './tool-portal-result-router.js';

describe('Tool Portal compact description routing', () => {
	it('truncates list and search output after full-text search while describe keeps full help', async () => {
		// Arrange
		const searchableSuffix = 'search-only-suffix';
		const fullDescription = `${'a'.repeat(280)} ${searchableSuffix}`;
		const capabilitySummary = {
			description: fullDescription,
			input: { optional: [], propertyCount: 0, required: [], type: 'object' as const },
			name: 'inspect',
			namespace: 'fixture',
			safety: {},
			toolRef: 'fixture:inspect',
		};
		const observedSearchQueries: string[] = [];
		const entry = {
			backend: {
				call: (): Promise<PortalCallResult> => Promise.resolve({ items: [], ok: true }),
				describe: (request): Promise<PortalBackendDescribeResult> =>
					Promise.resolve({
						items: request.requests.map(({ id }) => ({
							id,
							status: 'ok' as const,
							value: {
								tools: [
									{
										annotations: {},
										description: fullDescription,
										name: 'inspect',
										namespace: 'fixture',
										related: [],
										toolRef: 'fixture:inspect',
									},
								],
							},
						})),
						ok: true,
					}),
				list: (request): Promise<PortalBackendListResult> =>
					Promise.resolve({
						items: request.requests.map(({ id }) => ({
							id,
							status: 'ok' as const,
							value: { namespaces: ['fixture'], nextCursor: '8', tools: [capabilitySummary] },
						})),
						ok: true,
					}),
				search: (request): Promise<PortalBackendSearchResult> => {
					observedSearchQueries.push(...request.requests.map(({ query }) => query ?? ''));
					return Promise.resolve({
						items: request.requests.map(({ id, query }) => ({
							id,
							status: 'ok' as const,
							value: {
								tools: fullDescription.includes(query ?? '') ? [capabilitySummary] : [],
							},
						})),
						ok: true,
					});
				},
			},
			namespaceDiscovery: [{ namespace: 'fixture', summary: 'Fixture tools.' }],
			namespaces: new Set(['fixture']),
		} satisfies ToolPortalBackendEntry<undefined, undefined>;

		// Act
		const [listResult, searchResult, describeResult] = await Promise.all([
			mergeToolPortalList({
				entries: [entry],
				operationOptions: undefined,
				request: PortalListRequestSchema.parse({ requests: [{ id: 'list' }] }),
			}),
			mergeToolPortalSearch({
				entries: [entry],
				operationOptions: undefined,
				request: PortalSearchRequestSchema.parse({
					requests: [{ id: 'search', query: searchableSuffix }],
				}),
			}),
			mergeToolPortalDescribe({
				entries: [entry],
				operationOptions: undefined,
				request: PortalDescribeRequestSchema.parse({
					requests: [{ id: 'describe', refs: ['fixture:inspect'] }],
				}),
			}),
		]);
		const listedTool =
			listResult.items[0]?.status === 'ok' ? listResult.items[0].value.tools[0] : undefined;
		const searchedTool =
			searchResult.items[0]?.status === 'ok' ? searchResult.items[0].value.tools[0] : undefined;
		const describedTool =
			describeResult.items[0]?.status === 'ok' ? describeResult.items[0].value.tools[0] : undefined;

		// Assert
		expect(observedSearchQueries).toEqual([searchableSuffix]);
		expect(listResult.items[0]).toMatchObject({
			status: 'ok',
			value: { nextCursor: '8' },
		});
		for (const compactTool of [listedTool, searchedTool]) {
			expect(compactTool?.descriptionTruncated).toBe(true);
			expect(Array.from(compactTool?.description ?? '')).toHaveLength(240);
			expect(compactTool?.description).not.toContain(searchableSuffix);
		}
		expect(describedTool?.description).toBe(fullDescription);
		expect(describedTool).not.toHaveProperty('descriptionTruncated');
	});
});
