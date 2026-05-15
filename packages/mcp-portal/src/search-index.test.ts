import { describe, expect, it } from 'vitest';

import { createSearchIndex } from './search-index.js';
import { encodeToolRef } from './tool-ref.js';

describe('scoped search index', () => {
	it('searches names, descriptions, and schema fields only from provided tools', () => {
		const searchIndex = createSearchIndex([
			{
				description: 'Create a Linear issue',
				inputSchema: {
					properties: { title: { type: 'string' } },
					required: ['title'],
					type: 'object',
				},
				namespace: 'linear',
				toolName: 'create_issue',
			},
		]);

		expect(searchIndex.search({ query: 'title issue', limit: 10 }).results).toHaveLength(1);
		expect(searchIndex.search({ query: 'github repository', limit: 10 }).results).toHaveLength(0);
	});

	it('supports deterministic list-style search when query is omitted', () => {
		const searchIndex = createSearchIndex([
			{ inputSchema: { type: 'object' }, namespace: 'readwise', toolName: 'search' },
			{ inputSchema: { type: 'object' }, namespace: 'linear', toolName: 'create_issue' },
		]);

		expect(searchIndex.search({ limit: 10 }).results.map((result) => result.toolRef)).toEqual([
			'mcp:bGluZWFy:Y3JlYXRlX2lzc3Vl',
			'mcp:cmVhZHdpc2U:c2VhcmNo',
		]);
	});

	it('ranks tools using schema fields, relationships, and scoped skill text', () => {
		const commentToolRef = encodeToolRef({ namespace: 'linear', toolName: 'create_comment' });
		const searchIndex = createSearchIndex(
			[
				{
					description: 'Read an issue',
					inputSchema: {
						properties: { issueId: { description: 'Issue id', type: 'string' } },
						type: 'object',
					},
					namespace: 'linear',
					toolName: 'get_issue',
				},
				{
					description: 'Write a comment',
					inputSchema: {
						properties: {
							body: { description: 'Comment body', type: 'string' },
							issueId: { description: 'Issue id', type: 'string' },
						},
						type: 'object',
					},
					namespace: 'linear',
					toolName: 'create_comment',
				},
			],
			{
				relationships: [
					{
						field: 'issueId',
						from: {
							namespace: 'linear',
							toolName: 'get_issue',
							toolRef: encodeToolRef({ namespace: 'linear', toolName: 'get_issue' }),
						},
						reason: 'Issue id flows into comments.',
						to: { namespace: 'linear', toolName: 'create_comment', toolRef: commentToolRef },
						type: 'schema-field',
					},
				],
				skills: [
					{
						description: 'Triage issue comments',
						tags: ['triage'],
						title: 'Comment workflow',
						toolRefs: [commentToolRef],
					},
				],
			},
		);

		const results = searchIndex.search({ query: 'triage issue comment body', limit: 10 }).results;

		expect(results[0]?.toolName).toBe('create_comment');
		expect(results[0]?.schemaFieldMatches).toEqual(['body', 'issueId']);
		expect(results[0]?.relationshipHints).toEqual([
			{
				field: 'issueId',
				reason: 'Issue id flows into comments.',
				sourceToolRef: encodeToolRef({ namespace: 'linear', toolName: 'get_issue' }),
				type: 'schema-field',
			},
		]);
	});

	it('does not index denied skill text', () => {
		const searchIndex = createSearchIndex(
			[
				{
					description: 'Create an issue',
					inputSchema: { type: 'object' },
					namespace: 'linear',
					toolName: 'create_issue',
				},
			],
			{
				relationships: [],
				skills: [],
			},
		);

		expect(searchIndex.search({ query: 'highlight', limit: 10 }).results).toEqual([]);
	});
});
