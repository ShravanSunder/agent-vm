import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStaticSecretResolver } from '@agent-vm/secrets';
import { describe, expect, it, vi } from 'vitest';

import {
	deriveAgentBearerToken,
	formatMasterKeyFingerprint,
} from '../portal-auth/agent-bearer-token.js';
import {
	fakeUpstreamNamespace,
	startFakeUpstreamMcpServer,
} from '../testing/fake-upstream-mcp-server.js';
import {
	runMcpPortal,
	shouldRunMcpPortalEntrypoint,
	waitUntilPortalServerShutdown,
} from './mcp-portal.js';

class FakeSignalTarget {
	private readonly emitter = new EventEmitter();

	off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): void {
		this.emitter.off(signal, listener);
	}

	once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): void {
		this.emitter.once(signal, listener);
	}

	emit(signal: 'SIGINT' | 'SIGTERM'): void {
		this.emitter.emit(signal);
	}
}

const externalMasterKey = Buffer.from('0123456789abcdef0123456789abcdef');
const externalMasterKeyText = externalMasterKey.toString('base64url');

describe('mcp-portal CLI', () => {
	it('closes the serve runtime when a shutdown signal arrives', async () => {
		const signalTarget = new FakeSignalTarget();
		const close = vi.fn(async () => undefined);
		const shutdownPromise = waitUntilPortalServerShutdown({
			server: { close },
			signalTarget,
		});

		signalTarget.emit('SIGTERM');
		await shutdownPromise;

		expect(close).toHaveBeenCalledTimes(1);
	});

	it('uses mcp-proxy subcommands for external proxy operations', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'mcp-portal-credential-'));
		const previousMasterKey = process.env.MCP_PORTAL_MASTER_KEY;
		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
			stdoutChunks.push(String(chunk));
			return true;
		});
		const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
			stderrChunks.push(String(chunk));
			return true;
		});
		try {
			process.env.MCP_PORTAL_MASTER_KEY = externalMasterKeyText;
			await writeFile(
				join(workspace, 'mcp-portal.config.jsonc'),
				JSON.stringify({
					agents: { shravan: { profile: 'default' } },
					externalAuth: {
						masterKey: { name: 'MCP_PORTAL_MASTER_KEY', source: 'environment' },
					},
					mcpProxy: {
						auth: { headerName: 'authorization' },
						server: { host: '127.0.0.1', port: 18791 },
					},
					profiles: { default: { enabledNamespaces: [] } },
					schemaVersion: 1,
				}),
			);

			await expect(runMcpPortal(['serve', '--config-dir', workspace])).resolves.toBe(1);
			expect(
				await runMcpPortal([
					'mcp-proxy',
					'print-client-config',
					'--config-dir',
					workspace,
					'--agent',
					'shravan',
					'--master-key-fingerprint',
					formatMasterKeyFingerprint(externalMasterKey),
				]),
			).toBe(0);
			expect(stdoutChunks.join('')).toContain('Bearer ');
			expect(stderrChunks.join('')).toContain('WARNING');
		} finally {
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
			if (previousMasterKey === undefined) {
				delete process.env.MCP_PORTAL_MASTER_KEY;
			} else {
				process.env.MCP_PORTAL_MASTER_KEY = previousMasterKey;
			}
			await rm(workspace, { force: true, recursive: true });
		}
	});

	it('validates catalog files and reports wrapper metadata errors', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'mcp-portal-'));
		try {
			const validCatalogPath = join(workspace, 'catalog.json');
			const invalidCatalogPath = join(workspace, 'invalid.json');
			await writeFile(
				validCatalogPath,
				JSON.stringify({
					tools: [
						{ inputSchema: { type: 'object' }, namespace: 'linear', toolName: 'create_issue' },
					],
				}),
			);
			await writeFile(
				invalidCatalogPath,
				JSON.stringify({
					tools: [
						{
							inputSchema: { type: 'object' },
							metadata: { sessionId: 'portal-session' },
							namespace: 'linear',
							toolName: 'create_issue',
						},
					],
				}),
			);

			expect(await runMcpPortal(['validate', validCatalogPath])).toBe(0);
			expect(await runMcpPortal(['validate', invalidCatalogPath])).toBe(1);
		} finally {
			await rm(workspace, { force: true, recursive: true });
		}
	});

	it('generates catalog JSON and TypeScript helper files', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'mcp-portal-'));
		try {
			const catalogPath = join(workspace, 'catalog.json');
			const outputDir = join(workspace, 'generated');
			await writeFile(
				catalogPath,
				JSON.stringify({
					tools: [
						{ inputSchema: { type: 'object' }, namespace: 'linear', toolName: 'create_issue' },
					],
				}),
			);

			expect(await runMcpPortal(['generate-helper', catalogPath, '--out', outputDir])).toBe(0);
			await expect(readFile(join(outputDir, 'catalog.json'), 'utf-8')).resolves.toContain(
				'create_issue',
			);
			await expect(readFile(join(outputDir, 'catalog.ts'), 'utf-8')).resolves.toContain(
				'z.fromJSONSchema',
			);
		} finally {
			await rm(workspace, { force: true, recursive: true });
		}
	});

	it('exposes one public MCP Portal CLI binary', async () => {
		const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url));
		const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
			readonly bin?: Readonly<Record<string, string>>;
		};

		expect(packageJson.bin).toEqual({
			'mcp-portal': './dist/bin/mcp-portal.js',
		});
	});

	it('runs through package-manager symlinks named mcp-portal', () => {
		expect(shouldRunMcpPortalEntrypoint('/tmp/node_modules/.bin/mcp-portal')).toBe(true);
		expect(shouldRunMcpPortalEntrypoint('/repo/packages/mcp-portal/dist/bin/mcp-portal.js')).toBe(
			true,
		);
		expect(shouldRunMcpPortalEntrypoint('/repo/packages/mcp-portal/src/bin/mcp-portal.ts')).toBe(
			true,
		);
		expect(shouldRunMcpPortalEntrypoint('/repo/scripts/other.js')).toBe(false);
	});

	it('exports emitted portal-auth subpaths from the package build', async () => {
		const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url));
		const tsdownConfigPath = fileURLToPath(new URL('../../tsdown.config.ts', import.meta.url));
		const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
			readonly exports?: Readonly<Record<string, { readonly import?: string }>>;
		};
		const tsdownConfigText = await readFile(tsdownConfigPath, 'utf8');

		for (const exportPath of [
			'./portal-auth/agent-bearer-token',
			'./portal-auth/hmac-env',
			'./portal-auth/hmac-token',
		]) {
			expect(packageJson.exports?.[exportPath]?.import).toBe(`./dist/${exportPath.slice(2)}.js`);
			expect(tsdownConfigText).toContain(`src/${exportPath.slice(2)}.ts`);
		}
	});

	it('prints derived client config to stdout only after an explicit master-key fingerprint match', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'mcp-portal-credential-'));
		const previousMasterKey = process.env.MCP_PORTAL_MASTER_KEY;
		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
			stdoutChunks.push(String(chunk));
			return true;
		});
		const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
			stderrChunks.push(String(chunk));
			return true;
		});
		try {
			process.env.MCP_PORTAL_MASTER_KEY = externalMasterKeyText;
			await writeFile(
				join(workspace, 'mcp-portal.config.jsonc'),
				JSON.stringify({
					agents: { shravan: { profile: 'default' } },
					externalAuth: {
						masterKey: { name: 'MCP_PORTAL_MASTER_KEY', source: 'environment' },
					},
					mcpProxy: {
						auth: { headerName: 'authorization' },
						server: { host: '127.0.0.1', port: 18791 },
					},
					profiles: { default: { enabledNamespaces: [] } },
					schemaVersion: 1,
				}),
			);
			const bearer = deriveAgentBearerToken({ agentId: 'shravan', masterKey: externalMasterKey });

			expect(
				await runMcpPortal([
					'mcp-proxy',
					'print-client-config',
					'--config-dir',
					workspace,
					'--agent',
					'shravan',
					'--master-key-fingerprint',
					formatMasterKeyFingerprint(externalMasterKey),
				]),
			).toBe(0);
			const credential = JSON.parse(stdoutChunks.join('')) as {
				readonly authorizationHeaderName: string;
				readonly authorizationHeaderValue: string;
				readonly mcpServers: Readonly<Record<string, { readonly headers: Record<string, string> }>>;
				readonly proxyUrl: string;
			};

			expect(credential).toMatchObject({
				authorizationHeaderName: 'authorization',
				authorizationHeaderValue: `Bearer ${bearer}`,
				proxyUrl: 'http://127.0.0.1:18791/agents/shravan/mcp',
			});
			expect(credential.mcpServers['mcp-portal-shravan']?.headers.authorization).toBe(
				`Bearer ${bearer}`,
			);
			expect(stderrChunks.join('')).toContain('WARNING');
			expect(stderrChunks.join('')).toContain('bearer credential material');
			expect(stderrChunks.join('')).not.toContain(bearer);
		} finally {
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
			if (previousMasterKey === undefined) {
				delete process.env.MCP_PORTAL_MASTER_KEY;
			} else {
				process.env.MCP_PORTAL_MASTER_KEY = previousMasterKey;
			}
			await rm(workspace, { force: true, recursive: true });
		}
	});

	it('prints client config with custom header names and explicit proxy URL overrides', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'mcp-portal-credential-'));
		const previousMasterKey = process.env.MCP_PORTAL_MASTER_KEY;
		const stdoutChunks: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
			stdoutChunks.push(String(chunk));
			return true;
		});
		try {
			process.env.MCP_PORTAL_MASTER_KEY = externalMasterKeyText;
			await writeFile(
				join(workspace, 'mcp-portal.config.jsonc'),
				JSON.stringify({
					agents: { shravan: { profile: 'default' } },
					externalAuth: {
						masterKey: { name: 'MCP_PORTAL_MASTER_KEY', source: 'environment' },
					},
					mcpProxy: {
						auth: { headerName: 'x-mcp-portal-authorization' },
						server: { host: '127.0.0.1', port: 18791 },
					},
					profiles: { default: { enabledNamespaces: [] } },
					schemaVersion: 1,
				}),
			);
			const bearer = deriveAgentBearerToken({ agentId: 'shravan', masterKey: externalMasterKey });

			expect(
				await runMcpPortal([
					'mcp-proxy',
					'print-client-config',
					'--config-dir',
					workspace,
					'--agent',
					'shravan',
					'--master-key-fingerprint',
					formatMasterKeyFingerprint(externalMasterKey),
					'--proxy-url',
					'https://mcp-portal.example.com/agents/shravan/mcp',
				]),
			).toBe(0);
			const credential = JSON.parse(stdoutChunks.join('')) as {
				readonly authorizationHeaderName: string;
				readonly authorizationHeaderValue: string;
				readonly mcpServers: Readonly<Record<string, { readonly headers: Record<string, string> }>>;
				readonly proxyUrl: string;
			};

			expect(credential).toMatchObject({
				authorizationHeaderName: 'x-mcp-portal-authorization',
				authorizationHeaderValue: `Bearer ${bearer}`,
				proxyUrl: 'https://mcp-portal.example.com/agents/shravan/mcp',
			});
			expect(
				credential.mcpServers['mcp-portal-shravan']?.headers['x-mcp-portal-authorization'],
			).toBe(`Bearer ${bearer}`);
		} finally {
			stdoutSpy.mockRestore();
			if (previousMasterKey === undefined) {
				delete process.env.MCP_PORTAL_MASTER_KEY;
			} else {
				process.env.MCP_PORTAL_MASTER_KEY = previousMasterKey;
			}
			await rm(workspace, { force: true, recursive: true });
		}
	});

	it('prints client config with an explicit proxy URL when mcpProxy is absent', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'mcp-portal-credential-'));
		const previousMasterKey = process.env.MCP_PORTAL_MASTER_KEY;
		const stdoutChunks: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
			stdoutChunks.push(String(chunk));
			return true;
		});
		try {
			process.env.MCP_PORTAL_MASTER_KEY = externalMasterKeyText;
			await writeFile(
				join(workspace, 'mcp-portal.config.jsonc'),
				JSON.stringify({
					agents: { shravan: { profile: 'default' } },
					externalAuth: {
						masterKey: { name: 'MCP_PORTAL_MASTER_KEY', source: 'environment' },
					},
					profiles: { default: { enabledNamespaces: [] } },
					schemaVersion: 1,
				}),
			);
			const bearer = deriveAgentBearerToken({ agentId: 'shravan', masterKey: externalMasterKey });

			expect(
				await runMcpPortal([
					'mcp-proxy',
					'print-client-config',
					'--config-dir',
					workspace,
					'--agent',
					'shravan',
					'--master-key-fingerprint',
					formatMasterKeyFingerprint(externalMasterKey),
					'--proxy-url',
					'https://mcp-portal.example.com/agents/shravan/mcp',
				]),
			).toBe(0);
			const credential = JSON.parse(stdoutChunks.join('')) as {
				readonly authorizationHeaderName: string;
				readonly authorizationHeaderValue: string;
				readonly proxyUrl: string;
			};

			expect(credential).toMatchObject({
				authorizationHeaderName: 'authorization',
				authorizationHeaderValue: `Bearer ${bearer}`,
				proxyUrl: 'https://mcp-portal.example.com/agents/shravan/mcp',
			});
		} finally {
			stdoutSpy.mockRestore();
			if (previousMasterKey === undefined) {
				delete process.env.MCP_PORTAL_MASTER_KEY;
			} else {
				process.env.MCP_PORTAL_MASTER_KEY = previousMasterKey;
			}
			await rm(workspace, { force: true, recursive: true });
		}
	});

	it('refuses to print client config when the master-key fingerprint differs', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'mcp-portal-credential-'));
		const previousMasterKey = process.env.MCP_PORTAL_MASTER_KEY;
		const stdoutChunks: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
			stdoutChunks.push(String(chunk));
			return true;
		});
		try {
			process.env.MCP_PORTAL_MASTER_KEY = externalMasterKeyText;
			await writeFile(
				join(workspace, 'mcp-portal.config.jsonc'),
				JSON.stringify({
					agents: { shravan: { profile: 'default' } },
					externalAuth: {
						masterKey: { name: 'MCP_PORTAL_MASTER_KEY', source: 'environment' },
					},
					mcpProxy: {
						auth: { headerName: 'authorization' },
						server: { host: '127.0.0.1', port: 18791 },
					},
					profiles: { default: { enabledNamespaces: [] } },
					schemaVersion: 1,
				}),
			);

			expect(
				await runMcpPortal([
					'mcp-proxy',
					'print-client-config',
					'--config-dir',
					workspace,
					'--agent',
					'shravan',
					'--master-key-fingerprint',
					'sha256:not-the-key',
				]),
			).toBe(1);
			expect(stdoutChunks.join('')).toBe('');
		} finally {
			stdoutSpy.mockRestore();
			if (previousMasterKey === undefined) {
				delete process.env.MCP_PORTAL_MASTER_KEY;
			} else {
				process.env.MCP_PORTAL_MASTER_KEY = previousMasterKey;
			}
			await rm(workspace, { force: true, recursive: true });
		}
	});

	it('prints client config with a shared resolver for 1Password-backed master keys', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'mcp-portal-credential-'));
		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
			stdoutChunks.push(String(chunk));
			return true;
		});
		const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
			stderrChunks.push(String(chunk));
			return true;
		});
		try {
			await writeFile(
				join(workspace, 'mcp-portal.config.jsonc'),
				JSON.stringify({
					agents: { shravan: { profile: 'default' } },
					externalAuth: {
						masterKey: { ref: 'op://vault/mcp-portal/master-key', source: '1password' },
					},
					mcpProxy: {
						auth: { headerName: 'authorization' },
						server: { host: '127.0.0.1', port: 18791 },
					},
					profiles: { default: { enabledNamespaces: [] } },
					schemaVersion: 1,
				}),
			);
			const bearer = deriveAgentBearerToken({ agentId: 'shravan', masterKey: externalMasterKey });

			expect(
				await runMcpPortal(
					[
						'mcp-proxy',
						'print-client-config',
						'--config-dir',
						workspace,
						'--agent',
						'shravan',
						'--master-key-fingerprint',
						formatMasterKeyFingerprint(externalMasterKey),
					],
					{
						env: {},
						secretResolver: createStaticSecretResolver({
							'op://vault/mcp-portal/master-key': externalMasterKeyText,
						}),
					},
				),
			).toBe(0);
			const credential = JSON.parse(stdoutChunks.join('')) as {
				readonly authorizationHeaderValue: string;
			};

			expect(credential.authorizationHeaderValue).toBe(`Bearer ${bearer}`);
			expect(stderrChunks.join('')).not.toContain(bearer);
		} finally {
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
			await rm(workspace, { force: true, recursive: true });
		}
	});

	it('rejects the disabled credential file writer', async () => {
		const stderrChunks: string[] = [];
		const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
			stderrChunks.push(String(chunk));
			return true;
		});
		try {
			expect(
				await runMcpPortal([
					'mcp-proxy',
					'write-credential',
					'--config-dir',
					'/tmp/unused',
					'--agent',
					'shravan',
					'--out',
					'/tmp/unused.json',
					'--master-key-fingerprint',
					'sha256:not-used',
				]),
			).toBe(1);
			expect(stderrChunks.join('')).toContain('print-client-config');
			expect(stderrChunks.join('')).toContain('disabled');
		} finally {
			stderrSpy.mockRestore();
		}
	});

	it('streams call progress to stderr and writes the final core result to stdout', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'mcp-portal-call-'));
		const upstream = await startFakeUpstreamMcpServer();
		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
			stdoutChunks.push(String(chunk));
			return true;
		});
		const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
			stderrChunks.push(String(chunk));
			return true;
		});
		try {
			await writeFile(
				join(workspace, 'mcp.config.jsonc'),
				JSON.stringify({
					providers: {
						upstreamMock: {
							discovery: {},
							kind: 'mcp',
							namespace: fakeUpstreamNamespace,
							transport: {
								headers: {
									'x-upstream-api-key': {
										ref: 'op://vault/upstream/api-key',
										source: '1password',
									},
								},
								kind: 'streamable-http',
								requiredEgressHosts: [],
								url: upstream.url,
							},
						},
					},
					schemaVersion: 1,
				}),
			);
			await writeFile(
				join(workspace, 'mcp-portal.config.jsonc'),
				JSON.stringify({
					agents: { shravan: { profile: 'default' } },
					externalAuth: {
						masterKey: { ref: 'op://vault/mcp-portal/master-key', source: '1password' },
					},
					profiles: {
						default: {
							approval: {
								allowWithoutApprovalTools: [
									{ namespace: fakeUpstreamNamespace, toolName: 'read_thing' },
								],
								alwaysAskTools: [],
								annotationPolicy: 'destructive-requires-approval',
								trustedAnnotationNamespaces: [],
								writeTools: [],
							},
							enabledNamespaces: [fakeUpstreamNamespace],
							enabledToolsByNamespace: { [fakeUpstreamNamespace]: ['read_thing'] },
							hiddenToolsByNamespace: {},
						},
					},
					schemaVersion: 1,
				}),
			);
			const inputPath = join(workspace, 'call.json');
			await writeFile(
				inputPath,
				JSON.stringify({
					calls: [
						{
							arguments: { title: 'hello' },
							id: 'read-1',
							namespace: fakeUpstreamNamespace,
							toolName: 'read_thing',
						},
					],
				}),
			);

			expect(
				await runMcpPortal(
					['call', '--config-dir', workspace, '--agent', 'shravan', '--input', inputPath],
					{
						env: {},
						secretResolver: createStaticSecretResolver({
							'op://vault/mcp-portal/master-key': externalMasterKeyText,
							'op://vault/upstream/api-key': 'fake-upstream-api-key',
						}),
					},
				),
			).toBe(0);

			const stdoutJson = JSON.parse(stdoutChunks.join('')) as {
				readonly items: readonly {
					readonly requestId: string;
					readonly status: string;
					readonly structuredContent?: unknown;
				}[];
			};
			expect(stderrChunks.join('')).toContain('Calling upstream MCP tool');
			expect(stdoutJson.items).toEqual([
				expect.objectContaining({ requestId: 'read-1', status: 'success' }),
			]);
			expect(upstream.calls).toEqual([{ argumentsValue: { title: 'hello' }, name: 'read_thing' }]);
		} finally {
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
			await upstream.close();
			await rm(workspace, { force: true, recursive: true });
		}
	});
});
