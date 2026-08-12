import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStaticSecretResolver } from '@agent-vm/secret-management';
import { getConfig } from '@logtape/logtape';
import { parseSync } from '@optique/core/parser';
import { describe, expect, it, vi } from 'vitest';

import { mcpPortalRootParser } from '../cli/mcp-portal-cli-parser.js';
import {
	deriveAgentBearerToken,
	formatMasterKeyFingerprint,
} from '../portal-auth/agent-bearer-token.js';
import {
	fakeUpstreamNamespace,
	startFakeUpstreamMcpServer,
} from '../testing/fake-upstream-mcp-server.js';
import {
	runMcpPortalCommandWithProcessLogging,
	waitUntilPortalServerShutdown,
	type AgentVmMcpPortalRuntimeProps,
} from './mcp-portal-command-dispatcher.js';
import { shouldRunMcpPortalEntrypoint } from './mcp-portal.js';

const parserRejected = Symbol('parser-rejected');

async function runMcpPortal(
	args: readonly string[],
	props: AgentVmMcpPortalRuntimeProps = {},
): Promise<number | typeof parserRejected> {
	const parsed = parseSync(mcpPortalRootParser, args);
	if (!parsed.success) return parserRejected;
	return await runMcpPortalCommandWithProcessLogging(parsed.value, props);
}

class FakeSignalTarget {
	private readonly emitter = new EventEmitter();

	off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): void {
		this.emitter.off(signal, listener);
	}

	on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): void {
		this.emitter.on(signal, listener);
	}

	emit(signal: 'SIGINT' | 'SIGTERM'): void {
		this.emitter.emit(signal);
	}

	listenerCount(signal: 'SIGINT' | 'SIGTERM'): number {
		return this.emitter.listenerCount(signal);
	}
}

const externalMasterKey = Buffer.from('0123456789abcdef0123456789abcdef');
const externalMasterKeyText = externalMasterKey.toString('base64url');

describe('mcp-portal CLI', () => {
	it('distinguishes parser rejection from an operation failure', async () => {
		expect(await runMcpPortal(['validate'])).toBe(parserRejected);
		expect(parserRejected).not.toBe(1);
	});

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

	it('keeps a pending close path installed for a repeated signal', async () => {
		const signalTarget = new FakeSignalTarget();
		let resolveClose: (() => void) | undefined;
		let resolveCompletion: (() => void) | undefined;
		const closePromise = new Promise<void>((resolve) => {
			resolveClose = resolve;
		});
		const completionPromise = new Promise<void>((resolve) => {
			resolveCompletion = resolve;
		});
		const close = vi.fn(() => closePromise);
		const shutdownPromise = waitUntilPortalServerShutdown({
			onShutdownComplete: async () => await completionPromise,
			server: { close },
			signalTarget,
		});

		signalTarget.emit('SIGTERM');
		await Promise.resolve();
		expect(close).toHaveBeenCalledTimes(1);
		expect(signalTarget.listenerCount('SIGTERM')).toBe(1);

		signalTarget.emit('SIGTERM');
		await Promise.resolve();
		expect(close).toHaveBeenCalledTimes(1);

		resolveClose?.();
		await Promise.resolve();
		expect(signalTarget.listenerCount('SIGTERM')).toBe(1);
		signalTarget.emit('SIGTERM');
		expect(close).toHaveBeenCalledTimes(1);
		resolveCompletion?.();
		await shutdownPromise;
		expect(signalTarget.listenerCount('SIGTERM')).toBe(0);
		signalTarget.emit('SIGTERM');
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
					profiles: { default: { namespaces: {} } },
					schemaVersion: 1,
				}),
			);

			await expect(runMcpPortal(['serve', '--config-dir', workspace])).resolves.toBe(
				parserRejected,
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

	it('prints a valid client config URL for IPv6 loopback proxy hosts', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'mcp-portal-credential-'));
		const previousMasterKey = process.env.MCP_PORTAL_MASTER_KEY;
		const stdoutChunks: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
			stdoutChunks.push(String(chunk));
			return true;
		});
		const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
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
						server: { host: '::1', port: 18791 },
					},
					profiles: { default: { namespaces: {} } },
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
					formatMasterKeyFingerprint(externalMasterKey),
				]),
			).toBe(0);
			const clientConfig = JSON.parse(stdoutChunks.join('')) as { readonly proxyUrl: string };

			expect(clientConfig.proxyUrl).toBe('http://[::1]:18791/agents/shravan/mcp');
			expect(() => new URL(clientConfig.proxyUrl)).not.toThrow();
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

	it('does not configure process logging for CLI-only commands', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'mcp-portal-'));
		try {
			const catalogPath = join(workspace, 'catalog.json');
			await writeFile(catalogPath, JSON.stringify({ tools: [] }));

			expect(getConfig()).toBeNull();
			expect(await runMcpPortal(['validate', catalogPath])).toBe(0);
			expect(getConfig()).toBeNull();
		} finally {
			await rm(workspace, { force: true, recursive: true });
		}
	});

	it('keeps process logging setup failure bounded at the MCP Portal root', async () => {
		const stderrChunks: string[] = [];
		const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
			stderrChunks.push(String(chunk));
			return true;
		});
		try {
			await expect(
				runMcpPortal(['mcp-proxy', 'serve', '--config-dir', '/tmp/not-used'], {
					configureProcessLogging: async () => {
						throw new Error('connect https://collector.invalid/v1/logs with stack details');
					},
				}),
			).resolves.toBe(1);
			expect(stderrChunks).toEqual(['mcp-portal: process logging setup failed.\n']);
		} finally {
			stderrSpy.mockRestore();
		}
	});

	it('preserves portal startup failure when shutdown and fallback writing both fail', async () => {
		const fallbackFailure = new Error('stderr fallback failed');
		const stderrChunks: string[] = [];
		const stderrSpy = vi
			.spyOn(process.stderr, 'write')
			.mockImplementationOnce((chunk) => {
				stderrChunks.push(String(chunk));
				return true;
			})
			.mockImplementationOnce(() => {
				throw fallbackFailure;
			})
			.mockImplementation((chunk) => {
				stderrChunks.push(String(chunk));
				return true;
			});

		try {
			await expect(
				runMcpPortal(['mcp-proxy', 'serve', '--config-dir', '/tmp/not-used'], {
					configureProcessLogging: async () => ({
						shutdown: async (): Promise<void> => {
							throw new Error('logging shutdown failed');
						},
					}),
				}),
			).resolves.toBe(1);
			expect(stderrChunks.join('')).not.toContain('stderr fallback failed');
			expect(stderrChunks.join('')).toContain('not-used');
		} finally {
			stderrSpy.mockRestore();
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
					profiles: { default: { namespaces: {} } },
					schemaVersion: 1,
				}),
			);
			const bearer = deriveAgentBearerToken({
				agentId: 'shravan',
				credentialVersion: 1,
				masterKey: externalMasterKey,
			});

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
					profiles: { default: { namespaces: {} } },
					schemaVersion: 1,
				}),
			);
			const bearer = deriveAgentBearerToken({
				agentId: 'shravan',
				credentialVersion: 1,
				masterKey: externalMasterKey,
			});

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
					profiles: { default: { namespaces: {} } },
					schemaVersion: 1,
				}),
			);
			const bearer = deriveAgentBearerToken({
				agentId: 'shravan',
				credentialVersion: 1,
				masterKey: externalMasterKey,
			});

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
					profiles: { default: { namespaces: {} } },
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
					profiles: { default: { namespaces: {} } },
					schemaVersion: 1,
				}),
			);
			const bearer = deriveAgentBearerToken({
				agentId: 'shravan',
				credentialVersion: 1,
				masterKey: externalMasterKey,
			});

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
			expect(await runMcpPortal(['mcp-proxy', 'write-credential'])).toBe(1);
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
							namespaces: {
								[fakeUpstreamNamespace]: {
									calls: {
										requiresApproval: { allow: [] },
										withoutApproval: { allow: ['read_thing'] },
									},
									tools: { allow: ['read_thing'] },
								},
							},
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
