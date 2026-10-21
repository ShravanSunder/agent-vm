import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import { createHarness } from '#mcp-gateway/test-fixtures/mcp-gateway-harness';
import { paginateMcpTools, maximumToolListPageBytes } from '#mcp-gateway/tool-list-pagination';
import { resolveToolLoading, toolLoadingMode } from '#mcp-gateway/tool-loading';

function serializedBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

describe('serialized tools/list pages', () => {
	it('traverses a 170-tool multibyte catalog plus the four search tools without loss', () => {
		const tools: Tool[] = Array.from({ length: 170 }, (_, index) => ({
			name: `tool-${index}`,
			inputSchema: {
				type: 'object',
				properties: { payload: { type: 'string', description: '☃"\\\n'.repeat(3500) } },
			},
		}));
		const core = [
			'mcp_portal_list',
			'mcp_portal_search',
			'mcp_portal_describe',
			'mcp_portal_call',
		].map((name): Tool => ({ name, inputSchema: { type: 'object' } }));
		const whole = [...tools, ...core];
		const seen: Tool[] = [];
		const sizes: number[] = [];
		let cursor: string | undefined;
		do {
			const page = paginateMcpTools(whole, cursor);
			sizes.push(serializedBytes(page));
			expect(serializedBytes(page)).toBeLessThanOrEqual(1024 * 1024);
			seen.push(...page.tools);
			cursor = page.nextCursor;
		} while (cursor !== undefined);
		expect(sizes.length).toBeGreaterThan(1);
		expect(seen).toEqual(whole);
	});
	it('counts the cursor and accepts exactly one MiB while refusing one byte more', () => {
		const base: Tool = { name: 'near-boundary', inputSchema: { type: 'object' }, description: '' };
		const overhead = serializedBytes({ tools: [base], nextCursor: '1' });
		const exact = { ...base, description: 'x'.repeat(maximumToolListPageBytes - overhead) };
		const next: Tool = { name: 'next', inputSchema: { type: 'object' } };
		const page = paginateMcpTools([exact, next]);
		expect(serializedBytes(page)).toBe(1024 * 1024);
		expect(page.tools).toEqual([exact]);
		expect(page.nextCursor).toBe('1');
		expect(paginateMcpTools([exact, next], page.nextCursor)).toEqual({ tools: [next] });
		expect(() =>
			paginateMcpTools([{ ...exact, description: `${exact.description}x` }, next]),
		).toThrow('exceeds');
	});
	it.each(['-1', '1.5', '01', 'oops', '9007199254740992', '3'])(
		'refuses an invalid cursor %s',
		(cursor) => {
			expect(() =>
				paginateMcpTools([{ name: 'one', inputSchema: { type: 'object' } }], cursor),
			).toThrow();
		},
	);
	it('the gateway applies the budget to its direct list and keeps indirect bounded', async () => {
		const { gateway } = createHarness(undefined, 'complete', {
			toolDescription: '☃"'.repeat(80000),
		});
		const all: string[] = [];
		let pages = 0;
		async function visitPage(cursor?: string): Promise<void> {
			const page = await gateway.listTools('direct', cursor);
			expect(serializedBytes(page)).toBeLessThanOrEqual(1024 * 1024);
			all.push(...page.tools.map((tool) => tool.name));
			pages += 1;
			if (page.nextCursor !== undefined) await visitPage(page.nextCursor);
		}
		await visitPage();
		expect(pages).toBeGreaterThan(1);
		expect(all).toEqual([
			'alpha__ask__645775a667',
			'alpha__read__151160dc30',
			'beta__ask__7e2e2be604',
			'beta__read__08da93d672',
			'mcp_portal_list',
			'mcp_portal_search',
			'mcp_portal_describe',
			'mcp_portal_call',
		]);
		const indirect = await gateway.listTools('indirect');
		expect(indirect.tools).toHaveLength(4);
		expect(indirect.nextCursor).toBeUndefined();
		await expect(gateway.listTools('indirect', '1')).rejects.toThrow();
	});
});

describe('per-client tool loading from its address', () => {
	it.each([
		['https://portal/mcp?tools=direct', 'client-deferred', 'direct'],
		['https://portal/mcp', 'portal-deferred', 'indirect'],
		['/mcp?tools=indirect', 'portal-deferred', 'indirect'],
		['/mcp?agent=other&client=claude', 'portal-deferred', 'indirect'],
		['/mcp?tools=unknown', 'portal-deferred', 'indirect'],
	] as const)('chooses %s without caller-name inference', (address, kind, mode) => {
		const selection = resolveToolLoading(address);
		expect(selection).toEqual({ kind });
		expect(toolLoadingMode(selection)).toBe(mode);
	});
});
