#!/usr/bin/env node

import { serve } from '@hono/node-server';

import { createPortalHttpApp } from '../mcp-server/portal-http-server.js';

const port = Number.parseInt(process.env.MCP_PORTAL_PORT ?? '8787', 10);
const app = createPortalHttpApp({
	getBinding: () => null,
	toolRuntime: {
		callUpstreamTool: async () => {
			throw new Error('No portal binding runtime is configured for this standalone server.');
		},
		getSession: async () => {
			throw new Error('No portal session runtime is configured for this standalone server.');
		},
	},
});

serve({ fetch: app.fetch, port });
process.stderr.write(`mcp-portal-server listening on http://127.0.0.1:${port}\n`);
