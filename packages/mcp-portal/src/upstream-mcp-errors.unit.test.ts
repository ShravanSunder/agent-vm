import { describe, expect, it } from 'vitest';

import type { NormalizedUpstreamMcpServer } from './upstream-mcp-client-runtime.js';
import {
	sanitizeRemoteMcpUrlForDiagnostics,
	transportSummaryFromServer,
} from './upstream-mcp-errors.js';

describe('upstream MCP errors', () => {
	it('strips URL credentials and query values from remote transport summaries', () => {
		const server = {
			namespace: 'credentialed-provider',
			transport: 'streamable-http',
			url: 'https://user:secret@example.test/mcp?api_key=secret-value#token-fragment',
		} satisfies NormalizedUpstreamMcpServer;

		expect(transportSummaryFromServer(server)).toEqual({
			kind: 'streamable-http',
			url: 'https://example.test/mcp',
		});
		expect(sanitizeRemoteMcpUrlForDiagnostics(server.url)).not.toContain('secret');
		expect(sanitizeRemoteMcpUrlForDiagnostics(server.url)).not.toContain('api_key');
	});
});
