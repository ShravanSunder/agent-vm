import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	createNodeProviderRuntime,
	loadMcpConfig,
	resolveUpstreamServers,
} from '@agent-collaboration/tool-host-node';
import { startFakeUpstreamMcpServer } from '@agent-collaboration/tool-host-node/testing/fake-upstream-mcp-server';
import { expect, it } from 'vitest';

import { createLoadedSystemConfig } from '#agent-vm/config/system-config';
import { runLiveMcpPortalValidation } from '#agent-vm/operations/mcp-portal-live-validation';

import { startControlledProvider } from '../../../tool-host-node/src/test-fixtures/node-host-fixture.js';

it('validates modern and old providers with the actual production factory, then calls both through fresh runtime connections', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 's4d-live-validation-'));
	const modern = await startFakeUpstreamMcpServer();
	const old = await startControlledProvider('validation-old-only');
	try {
		const configDir = path.join(directory, 'tool-portal');
		await mkdir(configDir);
		const mcpConfig = {
			schemaVersion: 1 as const,
			providers: {
				modern: {
					kind: 'mcp' as const,
					namespace: 'modern',
					discovery: {},
					secretPolicies: {},
					transport: { kind: 'streamable-http' as const, url: modern.url, headers: {} },
				},
				old: {
					kind: 'mcp' as const,
					namespace: 'old',
					discovery: {},
					secretPolicies: {},
					transport: { kind: 'streamable-http' as const, url: old.url, headers: {} },
				},
			},
		};
		await writeFile(path.join(configDir, 'mcp.config.jsonc'), JSON.stringify(mcpConfig));
		await writeFile(
			path.join(configDir, 'tool-portal.config.jsonc'),
			JSON.stringify({
				schemaVersion: 1,
				mode: 'managed',
				agents: { main: { profile: 'default' } },
				profiles: {
					default: {
						namespaces: Object.fromEntries(
							['modern', 'old'].map((namespace) => [
								namespace,
								{
									backend: { kind: 'mcp_provider' },
									tools: { allow: '*' },
									calls: { requiresApproval: { allow: [] }, withoutApproval: { allow: '*' } },
								},
							]),
						),
					},
				},
			}),
		);
		const systemConfig = createLoadedSystemConfig(
			{
				schemaVersion: 2,
				host: { controllerPort: 18800, projectNamespace: 'row10b' },
				storageRootDir: path.join(directory, 'storage'),
				imageProfiles: {
					gateways: {
						hermes: { type: 'hermes', buildConfig: path.join(directory, 'gateway-build.json') },
					},
					toolVms: {
						default: { type: 'toolVm', buildConfig: path.join(directory, 'tool-build.json') },
					},
				},
				zones: [
					{
						id: 'row10b',
						agents: [{ id: 'main' }],
						toolPortal: { configDir, surfaceEligibilityByProfile: { default: {} } },
						gateway: {
							type: 'hermes',
							imageProfile: 'hermes',
							config: path.join(directory, 'config', 'gateways', 'hermes', 'config.yaml'),
							port: 18791,
							cpus: 2,
							memory: '2560M',
							profilesByAgent: { main: 'main' },
							profileSecretProjectionsByAgent: {
								main: {
									API_SERVER_KEY: 'API_SERVER_KEY_MAIN',
									DISCORD_BOT_TOKEN: 'DISCORD_TOKEN_MAIN',
								},
							},
						},
						secrets: {
							API_SERVER_KEY_MAIN: {
								audience: 'gateway',
								injection: 'env',
								source: 'environment',
								envVar: 'API_SERVER_KEY_MAIN',
							},
							DISCORD_TOKEN_MAIN: {
								audience: 'gateway',
								injection: 'env',
								source: 'environment',
								envVar: 'DISCORD_TOKEN_MAIN',
							},
						},
						egressHosts: [{ host: '127.0.0.1', audience: 'gateway' }],
						defaultToolVmProfile: 'default',
						agentToolVmProfiles: {},
					},
				],
				toolVmProfiles: { default: { imageProfile: 'default', cpus: 1, memory: '1G' } },
				tcpPool: { basePort: 19000, size: 5 },
			},
			{ systemConfigPath: path.join(directory, 'config', 'system.json') },
		);
		const checks = await runLiveMcpPortalValidation({
			systemConfig,
			secretResolver: {
				resolve: async () => {
					throw new Error('No secret resolution expected.');
				},
				resolveAll: async () => ({}),
			},
		});
		expect(checks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: 'mcp-live-row10b-modern', ok: true }),
				expect.objectContaining({ name: 'mcp-live-row10b-old', ok: true }),
			]),
		);
		expect(checks.every((check) => check.ok)).toBe(true);
		expect(modern.calls).toHaveLength(0);
		expect(old.effects).toHaveLength(0);
		const servers = await resolveUpstreamServers({
			config: await loadMcpConfig(path.join(configDir, 'mcp.config.jsonc')),
			resolveSecret: async () => {
				throw new Error('No secret resolution expected.');
			},
		});
		const runtime = createNodeProviderRuntime({ servers });
		try {
			expect(
				(await runtime.listTools({ agentScopeId: 'execution', namespace: 'modern' })).map(
					(tool) => tool.name,
				),
			).toContain('read_thing');
			expect(
				(await runtime.listTools({ agentScopeId: 'execution', namespace: 'old' })).map(
					(tool) => tool.name,
				),
			).toContain('read');
			await runtime.callTool({
				agentScopeId: 'execution',
				namespace: 'modern',
				toolName: 'read_thing',
				arguments: { title: 'validated modern' },
			});
			await runtime.callTool({
				agentScopeId: 'execution',
				namespace: 'old',
				toolName: 'read',
				arguments: { value: 41 },
			});
			expect(modern.calls).toEqual([
				{ name: 'read_thing', argumentsValue: { title: 'validated modern' } },
			]);
			expect(old.effects.map(({ name, arguments: args }) => ({ name, arguments: args }))).toEqual([
				{ name: 'read', arguments: { value: 41 } },
			]);
			expect(modern.requests.flatMap((request) => request.jsonRpcMethods)).not.toContain(
				'initialize',
			);
			expect(modern.requests.filter((request) => request.method === 'GET')).toHaveLength(0);
			expect(old.negotiatedVersions).toEqual(['2025-11-25', '2025-11-25']);
			process.stdout.write(
				`${JSON.stringify({ validationChecks: checks, modern: modern.requests, old: old.protocolAttempts, negotiated: old.negotiatedVersions })}\n`,
			);
		} finally {
			await runtime.closeAgentScope('execution');
		}
	} finally {
		await modern.close();
		await old.close();
		await rm(directory, { recursive: true, force: true });
	}
}, 20000);
