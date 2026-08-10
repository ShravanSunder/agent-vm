import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import type { SecretResolver } from '@agent-vm/secret-management';
import { reset } from '@logtape/logtape';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deriveAgentBearerToken } from '../portal-auth/agent-bearer-token.js';
import { configureProcessLogging } from './process-logging.js';
import {
	applyAgentOverrides,
	createServeSecretResolver,
	handlePortalServerError,
	startPortalServer,
	type PortalServerLogEvent,
} from './portal-server-operation.js';

const startedServers: { readonly close: () => Promise<void> }[] = [];
const externalMasterKey = Buffer.from('0123456789abcdef0123456789abcdef');
const externalMasterKeyText = externalMasterKey.toString('base64url');

class CaptureWritable extends Writable {
	readonly chunks: string[] = [];
	private pendingWrite: (() => void) | undefined;

	constructor() {
		super({
			write: (chunk, _encoding, callback) => {
				this.chunks.push(String(chunk));
				callback();
				this.pendingWrite?.();
				this.pendingWrite = undefined;
			},
		});
	}

	waitForWrite(): Promise<void> {
		if (this.chunks.length > 0) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this.pendingWrite = resolve;
		});
	}
}

afterEach(async () => {
	const serversToClose = startedServers.splice(0);
	await Promise.all(serversToClose.map((startedServer) => startedServer.close()));
	await reset();
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
			profiles: { default: { namespaces: {} } },
			schemaVersion: 1,
		}),
	);
	return configDir;
}

async function createProxyConfigDir(configuredPort = 18_791): Promise<string> {
	const configDir = await mkdtemp(join(tmpdir(), 'agent-vm-mcp-proxy-'));
	await writeFile(
		join(configDir, 'mcp.config.jsonc'),
		JSON.stringify({ providers: {}, schemaVersion: 1 }),
	);
	await writeFile(
		join(configDir, 'mcp-portal.config.jsonc'),
		JSON.stringify({
			agents: { shravan: { profile: 'default' } },
			externalAuth: {
				masterKey: { name: 'MCP_PORTAL_MASTER_KEY', source: 'environment' },
			},
			mcpProxy: {
				auth: { headerName: 'authorization' },
				server: { host: '127.0.0.1', port: configuredPort },
			},
			profiles: { default: { namespaces: {} } },
			schemaVersion: 1,
		}),
	);
	return configDir;
}

function createFakeOnePasswordResolver(): SecretResolver {
	return {
		resolve: async (ref) => `resolved:${ref.ref}`,
		resolveAll: async (refs) =>
			Object.fromEntries(Object.entries(refs).map(([name, ref]) => [name, `resolved:${ref.ref}`])),
	};
}

async function findAvailablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('Available-port probe did not expose a TCP port.');
	}
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error === undefined ? resolve() : reject(error)));
	});
	return address.port;
}

describe('applyAgentOverrides', () => {
	it('updates configured agents and rejects unknown agents', () => {
		expect(
			applyAgentOverrides(
				{
					shravan: {
						credentialVersion: 1,
						hmacKey: { name: 'KEY', source: 'environment' },
						profile: 'default',
					},
				},
				['shravan=builder'],
			),
		).toEqual({
			shravan: {
				credentialVersion: 1,
				hmacKey: { name: 'KEY', source: 'environment' },
				profile: 'builder',
			},
		});

		expect(() => applyAgentOverrides({}, ['unknown=builder'])).toThrow(/unknown/u);
	});
});

describe('createServeSecretResolver', () => {
	it('rejects ambient op-cli token source for external proxy 1Password refs', async () => {
		const resolveServiceAccountToken = vi.fn(async () => 'service-token');
		const createOnePasswordSecretResolver = vi.fn(async () => createFakeOnePasswordResolver());

		await expect(
			createServeSecretResolver(
				{
					AGENT_VM_MCP_PORTAL_OP_TOKEN_REF: 'op://agent-vm/mcp-portal-service-account/credential',
					AGENT_VM_MCP_PORTAL_OP_TOKEN_SOURCE: 'op-cli',
				},
				{ createOnePasswordSecretResolver, resolveServiceAccountToken },
			),
		).rejects.toThrow('Unsupported AGENT_VM_MCP_PORTAL_OP_TOKEN_SOURCE "op-cli"');
		expect(resolveServiceAccountToken).not.toHaveBeenCalled();
		expect(createOnePasswordSecretResolver).not.toHaveBeenCalled();
	});

	it('uses an explicit keychain token source for external proxy 1Password refs', async () => {
		const resolveServiceAccountToken = vi.fn(async () => 'keychain-token');
		const createOnePasswordSecretResolver = vi.fn(async () => createFakeOnePasswordResolver());

		await createServeSecretResolver(
			{
				AGENT_VM_MCP_PORTAL_OP_TOKEN_KEYCHAIN_ACCOUNT: 'agent-vm',
				AGENT_VM_MCP_PORTAL_OP_TOKEN_KEYCHAIN_SERVICE: 'mcp-portal',
				AGENT_VM_MCP_PORTAL_OP_TOKEN_SOURCE: 'keychain',
			},
			{ createOnePasswordSecretResolver, resolveServiceAccountToken },
		);

		expect(resolveServiceAccountToken).toHaveBeenCalledWith({
			account: 'agent-vm',
			service: 'mcp-portal',
			type: 'keychain',
		});
		expect(createOnePasswordSecretResolver).toHaveBeenCalledWith({
			serviceAccountToken: 'keychain-token',
		});
	});

	it('uses the supplied env snapshot for env-backed 1Password token bootstrap', async () => {
		const previousToken = process.env.PORTAL_TEST_SERVICE_ACCOUNT_TOKEN;
		delete process.env.PORTAL_TEST_SERVICE_ACCOUNT_TOKEN;
		const createOnePasswordSecretResolver = vi.fn(async () => createFakeOnePasswordResolver());
		try {
			await createServeSecretResolver(
				{
					AGENT_VM_MCP_PORTAL_OP_TOKEN_ENV_VAR: 'PORTAL_TEST_SERVICE_ACCOUNT_TOKEN',
					AGENT_VM_MCP_PORTAL_OP_TOKEN_SOURCE: 'env',
					PORTAL_TEST_SERVICE_ACCOUNT_TOKEN: 'snapshot-token',
				},
				{ createOnePasswordSecretResolver },
			);

			expect(createOnePasswordSecretResolver).toHaveBeenCalledWith({
				serviceAccountToken: 'snapshot-token',
			});
		} finally {
			if (previousToken === undefined) {
				delete process.env.PORTAL_TEST_SERVICE_ACCOUNT_TOKEN;
			} else {
				process.env.PORTAL_TEST_SERVICE_ACCOUNT_TOKEN = previousToken;
			}
		}
	});

	it('keeps env-only secret resolution available when no 1Password token source is configured', async () => {
		const resolver = await createServeSecretResolver({ LINEAR_MCP_TOKEN: 'linear-token' });

		await expect(
			resolver.resolve({ ref: 'LINEAR_MCP_TOKEN', source: 'environment' }),
		).resolves.toBe('linear-token');
		await expect(
			resolver.resolve({ ref: 'op://agent-vm/linear/credential', source: '1password' }),
		).rejects.toThrow(/requires host\.secretsProvider/u);
	});
});

describe('startPortalServer', () => {
	it('uses the configured proxy port when the CLI port is absent', async () => {
		const configuredPort = await findAvailablePort();
		const configDir = await createProxyConfigDir(configuredPort);
		const startedServer = await startPortalServer({
			args: { agentOverrides: [], configDir },
			env: {
				MCP_PORTAL_MASTER_KEY: externalMasterKeyText,
			},
			logger: { log: () => undefined },
		});
		startedServers.push(startedServer);

		expect(startedServer.port).toBe(configuredPort);
	});

	it('uses the default structured logger and disposes it after server close', async () => {
		const configDir = await createProxyConfigDir();
		const stderr = new CaptureWritable();
		const stdoutChunks: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
			stdoutChunks.push(String(chunk));
			return true;
		});
		const logging = await configureProcessLogging({ stderr });
		let startedServer: Awaited<ReturnType<typeof startPortalServer>> | undefined;
		try {
			startedServer = await startPortalServer({
				args: { agentOverrides: [], configDir, port: 0 },
				env: { MCP_PORTAL_MASTER_KEY: externalMasterKeyText },
			});
			await expect(
				fetch(`http://127.0.0.1:${String(startedServer.port)}/agents/shravan/mcp`),
			).resolves.toMatchObject({ status: 401 });
			await stderr.waitForWrite();
			await new Promise<void>((resolve) => setImmediate(resolve));
			await startedServer.close();
			startedServer = undefined;
			await logging.shutdown();

			const records = stderr.chunks.map(
				(chunk) =>
					JSON.parse(chunk) as {
						readonly logger?: string;
						readonly properties?: Readonly<Record<string, unknown>>;
					},
			);
			const authRecord = records.find((record) => record.logger === 'agent-vm.mcp-portal.server');
			expect(authRecord?.properties).toMatchObject({
				clientAddressClass: 'loopback',
				decision: 'deny',
				reason: 'missing',
			});
			expect(authRecord?.properties).not.toHaveProperty('clientAddress');
			expect(stdoutChunks.join('')).toContain('listening port=');
		} finally {
			if (startedServer !== undefined) {
				await startedServer.close();
			}
			await logging.shutdown();
			stdoutSpy.mockRestore();
		}
	});

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

	it('rejects config without external proxy startup settings', async () => {
		const configDir = await createPortalConfigDir();

		await expect(
			startPortalServer({
				args: { agentOverrides: [], configDir, port: 0 },
				env: {},
			}),
		).rejects.toThrow(/mcp-proxy.*externalAuth/u);
	});

	it('starts the external MCP proxy with derived bearer auth', async () => {
		const configDir = await createProxyConfigDir();
		const loggedEvents: PortalServerLogEvent[] = [];
		const startedServer = await startPortalServer({
			args: { agentOverrides: [], configDir, port: 0 },
			env: {
				MCP_PORTAL_MASTER_KEY: externalMasterKeyText,
			},
			logger: { log: (event) => loggedEvents.push(event) },
		});
		startedServers.push(startedServer);

		await expect(
			fetch(`http://127.0.0.1:${String(startedServer.port)}/agents/shravan/mcp`),
		).resolves.toMatchObject({ status: 401 });
		await expect(
			fetch(`http://127.0.0.1:${String(startedServer.port)}/agents/shravan/mcp`, {
				headers: {
					authorization: `Bearer ${deriveAgentBearerToken({
						agentId: 'shravan',
						credentialVersion: 1,
						masterKey: externalMasterKey,
					})}`,
				},
			}),
		).resolves.not.toMatchObject({ status: 401 });
		expect(loggedEvents).toEqual([
			expect.objectContaining({
				decision: 'deny',
				event: 'mcp_proxy_auth',
				level: 'warn',
				reason: 'missing',
			}),
			expect.objectContaining({
				decision: 'allow',
				event: 'mcp_proxy_auth',
				level: 'info',
			}),
		]);
	});

	it('rejects startup when the configured port cannot be bound', async () => {
		const configDir = await createProxyConfigDir();
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
						MCP_PORTAL_MASTER_KEY: externalMasterKeyText,
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
