import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { portalHmacKeyEnvName } from '../auth/hmac-env.js';
import { parsePortalServerCliArgs, startPortalServer } from './portal-server.js';

const startedServers: { readonly close: () => Promise<void> }[] = [];

afterEach(async () => {
	const serversToClose = startedServers.splice(0);
	await Promise.all(serversToClose.map((startedServer) => startedServer.close()));
});

async function createPortalConfigDir(): Promise<string> {
	const configDir = await mkdtemp(join(tmpdir(), 'agent-vm-portal-server-'));
	await writeFile(
		join(configDir, 'mcp.config.jsonc'),
		JSON.stringify({ providers: {}, schemaVersion: 1 }),
	);
	await writeFile(
		join(configDir, 'mcp-portal.config.jsonc'),
		JSON.stringify({
			agents: { shravan: { profile: 'default' } },
			profiles: { default: { enabledNamespaces: [] } },
			schemaVersion: 1,
			server: {
				accessHeader: {
					name: 'x-agent-vm-mcp-portal-secret',
					secret: { name: 'MCP_PORTAL_SERVER_SECRET', source: 'environment' },
				},
				host: '127.0.0.1',
				port: 18_790,
			},
		}),
	);
	return configDir;
}

describe('parsePortalServerCliArgs', () => {
	it('requires a config directory', () => {
		expect(() => parsePortalServerCliArgs([])).toThrow(/config-dir/u);
	});

	it('parses launch-only agent profile overrides', () => {
		expect(
			parsePortalServerCliArgs([
				'--config-dir',
				'/config',
				'--port',
				'0',
				'--agent',
				'shravan=builder',
			]),
		).toEqual({ agentOverrides: ['shravan=builder'], configDir: '/config', port: 0 });
	});
});

describe('startPortalServer', () => {
	it('starts a standalone Hono server and answers health', async () => {
		const configDir = await createPortalConfigDir();

		const startedServer = await startPortalServer({
			args: { agentOverrides: [], configDir, port: 0 },
			env: {
				MCP_PORTAL_SERVER_SECRET: 'server-secret',
				[portalHmacKeyEnvName('shravan')]: '00'.repeat(32),
			},
		});
		startedServers.push(startedServer);

		const response = await fetch(`http://127.0.0.1:${String(startedServer.port)}/health`);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ agents: ['shravan'], ok: true });
	});
});
