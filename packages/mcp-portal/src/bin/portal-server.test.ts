import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { portalHmacKeyEnvName } from '../auth/hmac-env.js';
import {
	applyAgentOverrides,
	handlePortalServerError,
	isPortalServerEntrypoint,
	parsePortalServerCliArgs,
	startPortalServer,
	type PortalServerLogEvent,
} from './portal-server.js';

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

describe('applyAgentOverrides', () => {
	it('updates configured agents and rejects unknown agents', () => {
		expect(
			applyAgentOverrides(
				{ shravan: { hmacKey: { name: 'KEY', source: 'environment' }, profile: 'default' } },
				['shravan=builder'],
			),
		).toEqual({
			shravan: { hmacKey: { name: 'KEY', source: 'environment' }, profile: 'builder' },
		});

		expect(() => applyAgentOverrides({}, ['unknown=builder'])).toThrow(/unknown/u);
	});
});

describe('isPortalServerEntrypoint', () => {
	it('recognizes filesystem symlinks to the server entrypoint', async () => {
		const targetDir = await mkdtemp(join(tmpdir(), 'agent-vm-portal-entrypoint-'));
		const realEntrypointPath = join(targetDir, 'portal-server.js');
		const symlinkEntrypointPath = join(targetDir, 'agent-vm-mcp-portal-server');
		await writeFile(realEntrypointPath, 'export {};\n', 'utf8');
		await symlink(realEntrypointPath, symlinkEntrypointPath);

		try {
			await expect(
				isPortalServerEntrypoint(
					pathToFileURL(realEntrypointPath).href,
					symlinkEntrypointPath,
				),
			).resolves.toBe(true);
		} finally {
			await rm(targetDir, { force: true, recursive: true });
		}
	});

	it('recognizes symlinked argv entrypoints by resolved path', async () => {
		const realPaths: Readonly<Record<string, string>> = {
			'/opt/agent-vm/portal/bin/agent-vm-mcp-portal-server':
				'/pnpm/global/5/.pnpm/@agent-vm+mcp-portal@0.0.65/node_modules/@agent-vm/mcp-portal/dist/bin/portal-server.js',
			'/pnpm/global/5/node_modules/@agent-vm/mcp-portal/dist/bin/portal-server.js':
				'/pnpm/global/5/.pnpm/@agent-vm+mcp-portal@0.0.65/node_modules/@agent-vm/mcp-portal/dist/bin/portal-server.js',
		};

		await expect(
			isPortalServerEntrypoint(
				'file:///pnpm/global/5/node_modules/@agent-vm/mcp-portal/dist/bin/portal-server.js',
				'/opt/agent-vm/portal/bin/agent-vm-mcp-portal-server',
				async (targetPath) => {
					const realPath = realPaths[targetPath];
					if (realPath === undefined) {
						throw new Error(`unexpected path ${targetPath}`);
					}
					return realPath;
				},
			),
		).resolves.toBe(true);
	});

	it('rejects missing or unresolved argv entrypoints', async () => {
		await expect(isPortalServerEntrypoint('file:///portal-server.js', undefined)).resolves.toBe(
			false,
		);
		await expect(
			isPortalServerEntrypoint('file:///portal-server.js', '/missing', async () => {
				throw new Error('missing');
			}),
		).resolves.toBe(false);
	});
});

describe('startPortalServer', () => {
	it('logs post-listen server errors without rejecting the resolved listener', () => {
		const rejectedErrors: Error[] = [];
		const loggedEvents: PortalServerLogEvent[] = [];

		handlePortalServerError({
			error: new Error('accept failed'),
			hasListened: true,
			listeningPort: {
				promise: Promise.resolve(18_790),
				reject: (error) => {
					rejectedErrors.push(error);
				},
				resolve: () => undefined,
			},
			logger: { log: (event) => loggedEvents.push(event) },
		});

		expect(rejectedErrors).toEqual([]);
		expect(loggedEvents).toEqual([
			expect.objectContaining({
				event: 'server_error',
				level: 'error',
				message: 'accept failed',
			}),
		]);
	});

	it('rejects pre-listen server errors after logging them', () => {
		const rejectedErrors: Error[] = [];
		const loggedEvents: PortalServerLogEvent[] = [];
		const bindError = new Error('bind failed');

		handlePortalServerError({
			error: bindError,
			hasListened: false,
			listeningPort: {
				promise: Promise.reject(bindError).catch(() => 0),
				reject: (error) => {
					rejectedErrors.push(error);
				},
				resolve: () => undefined,
			},
			logger: { log: (event) => loggedEvents.push(event) },
		});

		expect(rejectedErrors).toEqual([bindError]);
		expect(loggedEvents).toEqual([
			expect.objectContaining({
				event: 'server_error',
				level: 'error',
				message: 'bind failed',
			}),
		]);
	});

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

	it('rejects startup when the configured port cannot be bound', async () => {
		const configDir = await createPortalConfigDir();
		const reservedServer = createServer();
		await new Promise<void>((resolve) => {
			reservedServer.listen(0, '127.0.0.1', resolve);
		});
		const address = reservedServer.address();
		if (address === null || typeof address === 'string') {
			throw new Error('reserved server did not expose a TCP port');
		}

		try {
			await expect(
				startPortalServer({
					args: { agentOverrides: [], configDir, port: address.port },
					env: {
						MCP_PORTAL_SERVER_SECRET: 'server-secret',
						[portalHmacKeyEnvName('shravan')]: '00'.repeat(32),
					},
					logger: { log: () => undefined },
				}),
			).rejects.toThrow();
		} finally {
			await new Promise<void>((resolve, reject) => {
				reservedServer.close((error) => {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
				});
			});
		}
	});
});
