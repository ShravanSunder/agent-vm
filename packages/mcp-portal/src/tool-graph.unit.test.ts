import { describe, expect, it } from 'vitest';

import { buildToolGraph } from './tool-graph.js';
import { encodeToolRef } from './tool-ref.js';

describe('scoped tool graph', () => {
	it('links tools through shared non-generic schema fields', () => {
		const graph = buildToolGraph({
			skills: [],
			tools: [
				{
					inputSchema: { type: 'object' },
					namespace: 'linear',
					outputSchema: {
						properties: { issueId: { type: 'string' } },
						required: ['issueId'],
						type: 'object',
					},
					toolName: 'search_issues',
				},
				{
					inputSchema: {
						properties: { issueId: { type: 'string' } },
						required: ['issueId'],
						type: 'object',
					},
					namespace: 'linear',
					toolName: 'get_issue',
				},
				{
					inputSchema: {
						properties: { body: { type: 'string' }, issueId: { type: 'string' } },
						required: ['issueId', 'body'],
						type: 'object',
					},
					namespace: 'linear',
					toolName: 'create_comment',
				},
			],
		});

		expect(graph.relationships.map((relationship) => relationship.to.toolName)).toEqual([
			'create_comment',
			'get_issue',
		]);
		expect(graph.relationships.every((relationship) => relationship.type === 'schema-field')).toBe(
			true,
		);
	});

	it('does not link cross-namespace tools through generic id fields', () => {
		const graph = buildToolGraph({
			skills: [],
			tools: [
				{
					inputSchema: { type: 'object' },
					namespace: 'linear',
					outputSchema: {
						properties: { id: { type: 'string' } },
						required: ['id'],
						type: 'object',
					},
					toolName: 'search_issues',
				},
				{
					inputSchema: {
						properties: { id: { type: 'string' } },
						required: ['id'],
						type: 'object',
					},
					namespace: 'github',
					toolName: 'get_issue',
				},
			],
		});

		expect(graph.relationships).toEqual([]);
	});

	it('stable-sorts relationships by type and target toolRef', () => {
		const graph = buildToolGraph({
			skills: [],
			tools: [
				{
					inputSchema: { type: 'object' },
					namespace: 'linear',
					outputSchema: {
						properties: { issueId: { type: 'string' } },
						type: 'object',
					},
					toolName: 'search_issues',
				},
				{
					inputSchema: { properties: { issueId: { type: 'string' } }, type: 'object' },
					namespace: 'linear',
					toolName: 'z_get_issue',
				},
				{
					inputSchema: { properties: { issueId: { type: 'string' } }, type: 'object' },
					namespace: 'linear',
					toolName: 'a_comment',
				},
			],
		});

		expect(graph.relationships.map((relationship) => relationship.to.toolRef)).toEqual(
			[
				encodeToolRef({ namespace: 'linear', toolName: 'a_comment' }),
				encodeToolRef({ namespace: 'linear', toolName: 'z_get_issue' }),
			].toSorted(),
		);
	});

	it('filters skill relations to the scoped tool set', () => {
		const linearToolRef = encodeToolRef({ namespace: 'linear', toolName: 'create_issue' });
		const linearSearchToolRef = encodeToolRef({ namespace: 'linear', toolName: 'search_issues' });
		const readwiseToolRef = encodeToolRef({ namespace: 'readwise', toolName: 'search_highlights' });
		const graph = buildToolGraph({
			skills: [
				{
					description: 'Create issues from selected highlights',
					tags: ['triage'],
					title: 'Highlight triage',
					toolRefs: [linearToolRef, linearSearchToolRef, readwiseToolRef],
				},
				{
					description: 'Only denied tools',
					tags: ['notes'],
					title: 'Denied skill',
					toolRefs: [readwiseToolRef],
				},
			],
			tools: [
				{
					inputSchema: { type: 'object' },
					namespace: 'linear',
					toolName: 'create_issue',
				},
				{
					inputSchema: { type: 'object' },
					namespace: 'linear',
					toolName: 'search_issues',
				},
			],
		});

		expect(graph.skills).toEqual([
			{
				description: 'Create issues from selected highlights',
				tags: ['triage'],
				title: 'Highlight triage',
				toolRefs: [linearToolRef, linearSearchToolRef].toSorted(),
			},
		]);
		expect(graph.relationships.map((relationship) => relationship.type)).toEqual([
			'skill',
			'skill',
		]);
		expect(JSON.stringify(graph)).not.toContain('readwise');
	});

	it('links tools that declare the same schema entity', () => {
		const graph = buildToolGraph({
			tools: [
				{
					inputSchema: { title: 'Issue', type: 'object' },
					namespace: 'linear',
					toolName: 'get_issue',
				},
				{
					inputSchema: { title: 'Issue', type: 'object' },
					namespace: 'github',
					toolName: 'get_issue',
				},
			],
		});

		expect(graph.relationships).toEqual([
			expect.objectContaining({ type: 'entity' }),
			expect.objectContaining({ type: 'entity' }),
		]);
	});
});
