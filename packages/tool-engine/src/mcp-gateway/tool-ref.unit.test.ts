import { describe, expect, it } from 'vitest';

import { decodeToolRef, encodeToolRef } from '#mcp-gateway/tool-ref';

describe('tool refs', () => {
	it('round trips namespace and tool name without exposing server internals', () => {
		const toolRef = encodeToolRef({ namespace: 'linear', toolName: 'create_issue' });

		expect(toolRef).toMatch(/^mcp:/);
		expect(toolRef).not.toContain('binding');
		expect(decodeToolRef(toolRef)).toEqual({
			namespace: 'linear',
			toolName: 'create_issue',
		});
	});

	it('round trips names that would be ambiguous in raw colon-delimited refs', () => {
		const identity = { namespace: 'team/linear prod', toolName: 'issue:create_comment' };

		expect(decodeToolRef(encodeToolRef(identity))).toEqual(identity);
	});

	it('rejects malformed refs', () => {
		expect(() => decodeToolRef('linear:create_issue')).toThrow('Invalid MCP toolRef.');
		expect(() => decodeToolRef('mcp:not-json')).toThrow('Invalid MCP toolRef.');
		expect(() => decodeToolRef('mcp:linear:create_issue')).toThrow('Invalid MCP toolRef.');
	});
});

describe('frozen pre-extraction reference bytes', () => {
	it.each([
		{ namespace: 'linear', toolName: 'create_issue', ref: 'mcp:bGluZWFy:Y3JlYXRlX2lzc3Vl' },
		{ namespace: '雪', toolName: 'café:read', ref: 'mcp:6Zuq:Y2Fmw6k6cmVhZA' },
		{ namespace: 'a:b', toolName: 'x/y', ref: 'mcp:YTpi:eC95' },
		{ namespace: 'a\u0000', toolName: 'b', ref: 'mcp:YQA:Yg' },
	])('encodes and independently decodes $ref', ({ namespace, toolName, ref }) => {
		expect(encodeToolRef({ namespace, toolName })).toBe(ref);
		expect(decodeToolRef(ref)).toEqual({ namespace, toolName });
	});
	it.each([
		'mcp:YQ==:Yg',
		'mcp:YR:Yg',
		'mcp:_w:Yg',
		'mcp:wK8:Yg',
		'mcp:7aCA:Yg',
		'mcp:YQ:Yg:extra',
	])('rejects noncanonical/invalid UTF-8 %s', (ref) =>
		expect(() => decodeToolRef(ref)).toThrow('Invalid MCP toolRef.'),
	);
});
