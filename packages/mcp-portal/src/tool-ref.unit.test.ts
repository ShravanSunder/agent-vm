import { describe, expect, it } from 'vitest';

import { decodeToolRef, encodeToolRef } from './tool-ref.js';

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
