import { describe, expect, it } from 'vitest';

import { normalizeOpenClawMcpServers } from './openclaw-mcp-server-config.js';

describe('OpenClaw MCP server config normalization', () => {
	it('normalizes stdio, streamable HTTP, and SSE records', () => {
		const result = normalizeOpenClawMcpServers({
			github: {
				headers: { Authorization: 'Bearer secret' },
				transport: 'streamable-http',
				url: 'https://mcp.test',
			},
			linear: {
				args: ['--stdio'],
				command: 'linear-mcp',
				env: { LD_PRELOAD: 'bad', SAFE_ENV: 'ok' },
			},
			readwise: { headers: { 'x-api-key': 123 }, type: 'sse', url: 'https://sse.test' },
		});

		expect(result.servers).toEqual([
			expect.objectContaining({ namespace: 'github', transport: 'streamable-http' }),
			expect.objectContaining({ env: { SAFE_ENV: 'ok' }, namespace: 'linear', transport: 'stdio' }),
			expect.objectContaining({
				headers: { 'x-api-key': '123' },
				namespace: 'readwise',
				transport: 'sse',
			}),
		]);
		expect(result.diagnostics).toEqual([]);
	});

	it('uses auto-http for remote servers without an explicit transport', () => {
		const result = normalizeOpenClawMcpServers({
			remote: { headers: {}, url: 'https://mcp.test' },
		});

		expect(result.servers).toEqual([
			expect.objectContaining({ namespace: 'remote', transport: 'auto-http' }),
		]);
	});

	it('skips malformed servers with redacted diagnostics', () => {
		const result = normalizeOpenClawMcpServers({
			broken: { headers: { Authorization: 'Bearer secret' }, transport: 'sse' },
		});

		expect(result.servers).toEqual([]);
		expect(result.diagnostics[0]?.message).toContain('broken');
		expect(JSON.stringify(result.diagnostics)).not.toContain('secret');
	});
});
