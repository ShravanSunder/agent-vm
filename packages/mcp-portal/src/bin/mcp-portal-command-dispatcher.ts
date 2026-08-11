#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
	loadMcpConfig,
	loadMcpPortalConfig,
	type McpPortalConfig,
	type SecretValue,
} from '@agent-vm/config-contracts';
import type { SecretResolver } from '@agent-vm/secret-management';
import { z } from 'zod';

import { portalToolRecordSchema, type PortalToolRecord } from '../catalog-types.js';
import type { McpPortalCommand } from '../cli/mcp-portal-cli-parser.js';
import {
	buildProfilePolicyMaps,
	createServeSecretResolver,
	deriveApprovalHmacKeysFromMasterKey,
	startPortalServer,
} from '../cli/portal-server-operation.js';
import { createPortalCore, type PortalCoreEvent } from '../core/portal-core.js';
import { resolveUpstreamServers } from '../core/provider-runtime.js';
import {
	createPortalAgentRuntimeRecords,
	createPortalApprovalVerifier,
	resolveAgentHmacKeys,
} from '../mcp-proxy/resolve-agent-identity.js';
import {
	decodePortalMasterKey,
	deriveAgentBearerToken,
	formatMasterKeyFingerprint,
} from '../portal-auth/agent-bearer-token.js';
import { parseHmacKeysFromEnv } from '../portal-auth/hmac-env.js';
import { generateTypescriptCatalogArtifact } from '../portal-config/typescript-artifact.js';
import { createUpstreamMcpClientRuntime } from '../upstream-mcp-client-runtime.js';
import { resolveSecretValue } from './secret-value-resolver.js';

const catalogFileSchema = z
	.object({
		tools: z.array(portalToolRecordSchema),
	})
	.strict();

export interface PortalCatalogFile {
	readonly tools: readonly PortalToolRecord[];
}

export interface AgentVmMcpPortalRuntimeProps {
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly secretResolver?: SecretResolver;
}

async function readCatalogFile(catalogPath: string): Promise<PortalCatalogFile> {
	const rawCatalog = await readFile(catalogPath, 'utf-8');
	const parsedJson = JSON.parse(rawCatalog) as unknown;
	return catalogFileSchema.parse(parsedJson);
}

type RequiredPortalRuntimeProps = Required<Pick<AgentVmMcpPortalRuntimeProps, 'env'>> &
	Pick<AgentVmMcpPortalRuntimeProps, 'secretResolver'>;

async function createCliSecretResolver(props: RequiredPortalRuntimeProps): Promise<SecretResolver> {
	return props.secretResolver ?? (await createServeSecretResolver(props.env));
}

interface McpPortalClientConfigServer {
	readonly headers: Readonly<Record<string, string>>;
	readonly type: 'streamable-http';
	readonly url: string;
}

interface McpPortalClientConfig {
	readonly agentId: string;
	readonly authorizationHeaderName: string;
	readonly authorizationHeaderValue: string;
	readonly kind: 'mcp-portal-client-config';
	readonly masterKeyFingerprint: string;
	readonly mcpServers: Readonly<Record<string, McpPortalClientConfigServer>>;
	readonly proxyUrl: string;
	readonly schemaVersion: 1;
}

function serverNameForClientConfig(agentId: string): string {
	return `mcp-portal-${agentId.replaceAll(/[^A-Za-z0-9_-]/gu, '-')}`;
}

function printCredentialMaterialWarning(): void {
	process.stderr.write(
		[
			'WARNING: MCP Portal client config is bearer credential material.',
			'WARNING: Treat stdout like an API token. Do not paste it into logs, commits, or chat.',
			'WARNING: The token is per-agent and remains valid until credentialVersion or masterKey rotation.',
			'',
		].join('\n'),
	);
}

function printDisabledCredentialWriter(): number {
	process.stderr.write(
		[
			'mcp-portal: mcp-proxy write-credential is disabled because it persists bearer credentials.',
			'Use mcp-portal mcp-proxy print-client-config and decide explicitly where stdout is stored.',
			'',
		].join('\n'),
	);
	return 1;
}

async function printClientConfig(
	command: Extract<McpPortalCommand, { readonly command: 'mcp-proxy.print-client-config' }>,
	runtimeProps: RequiredPortalRuntimeProps,
): Promise<number> {
	const { agentId, configDir, expectedFingerprint, proxyUrl: proxyUrlOverride } = command;
	const portalConfig = await loadMcpPortalConfig(join(configDir, 'mcp-portal.config.jsonc'));
	if (portalConfig.externalAuth === undefined) {
		throw new Error('print-client-config requires externalAuth.masterKey.');
	}
	if (portalConfig.mcpProxy === undefined && proxyUrlOverride === undefined) {
		throw new Error('print-client-config requires mcpProxy server settings or --proxy-url.');
	}
	if (portalConfig.agents[agentId] === undefined) {
		throw new Error(`Unknown MCP Portal agent "${agentId}".`);
	}
	const secretResolver = await createCliSecretResolver(runtimeProps);
	const masterKey = decodePortalMasterKey(
		await resolveSecretValue(portalConfig.externalAuth.masterKey, {
			env: runtimeProps.env,
			secretResolver,
		}),
	);
	const actualFingerprint = formatMasterKeyFingerprint(masterKey);
	if (actualFingerprint !== expectedFingerprint) {
		throw new Error(
			`Master-key fingerprint mismatch. Expected ${expectedFingerprint}; resolved ${actualFingerprint}.`,
		);
	}
	const agentConfig = portalConfig.agents[agentId];
	const bearer = deriveAgentBearerToken({
		agentId,
		credentialVersion: agentConfig.credentialVersion,
		masterKey,
	});
	const proxyUrl =
		proxyUrlOverride ??
		credentialProxyUrlFromConfig(requireCredentialMcpProxy(portalConfig.mcpProxy), agentId);
	const authorizationHeaderName = portalConfig.mcpProxy?.auth.headerName ?? 'authorization';
	const authorizationHeaderValue = `Bearer ${bearer}`;
	const clientConfig = {
		agentId,
		authorizationHeaderName,
		authorizationHeaderValue,
		kind: 'mcp-portal-client-config',
		masterKeyFingerprint: actualFingerprint,
		mcpServers: {
			[serverNameForClientConfig(agentId)]: {
				headers: { [authorizationHeaderName]: authorizationHeaderValue },
				type: 'streamable-http',
				url: proxyUrl,
			},
		},
		proxyUrl,
		schemaVersion: 1,
	} satisfies McpPortalClientConfig;
	printCredentialMaterialWarning();
	process.stdout.write(`${JSON.stringify(clientConfig, null, '\t')}\n`);
	return 0;
}

function requireCredentialMcpProxy(
	mcpProxy: McpPortalConfig['mcpProxy'],
): NonNullable<McpPortalConfig['mcpProxy']> {
	if (mcpProxy === undefined) {
		throw new Error('print-client-config requires mcpProxy server settings or --proxy-url.');
	}
	return mcpProxy;
}

function credentialProxyUrlFromConfig(
	mcpProxy: NonNullable<McpPortalConfig['mcpProxy']>,
	agentId: string,
): string {
	const host = mcpProxy.server.host.includes(':')
		? `[${mcpProxy.server.host.replace(/^\[|\]$/gu, '')}]`
		: mcpProxy.server.host;
	return `http://${host}:${String(mcpProxy.server.port)}/agents/${encodeURIComponent(agentId)}/mcp`;
}

type PortalShutdownSignal = 'SIGINT' | 'SIGTERM';
interface PortalSignalTarget {
	readonly off: (signal: PortalShutdownSignal, listener: () => void) => void;
	readonly once: (signal: PortalShutdownSignal, listener: () => void) => void;
}

export interface RunningPortalServer {
	readonly close: () => Promise<void>;
}

function waitForPortalShutdownSignal(
	signalTarget: PortalSignalTarget = process,
): Promise<PortalShutdownSignal> {
	const signals = ['SIGINT', 'SIGTERM'] satisfies readonly PortalShutdownSignal[];
	return new Promise((resolve) => {
		const listeners = new Map<PortalShutdownSignal, () => void>();
		for (const signal of signals) {
			const listener = (): void => {
				for (const [registeredSignal, registeredListener] of listeners) {
					signalTarget.off(registeredSignal, registeredListener);
				}
				resolve(signal);
			};
			listeners.set(signal, listener);
			signalTarget.once(signal, listener);
		}
	});
}

export async function waitUntilPortalServerShutdown(props: {
	readonly server: RunningPortalServer;
	readonly signalTarget?: PortalSignalTarget;
}): Promise<void> {
	try {
		await waitForPortalShutdownSignal(props.signalTarget);
	} finally {
		await props.server.close();
	}
}

function writePortalCoreEventToStderr(event: PortalCoreEvent): void {
	if (event.kind === 'progress' && event.message !== undefined) {
		process.stderr.write(`${event.message}\n`);
		return;
	}
	if (event.kind === 'partial_content') {
		const message =
			event.content.type === 'text' ? event.content.text : JSON.stringify(event.content.value);
		process.stderr.write(`${message}\n`);
		return;
	}
	if (event.kind === 'upstream_notification') {
		process.stderr.write(`upstream notification ${event.method}\n`);
	}
}

async function resolveCliApprovalHmacKeys(props: {
	readonly agentIds: readonly string[];
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly portalConfig: Awaited<ReturnType<typeof loadMcpPortalConfig>>;
	readonly resolveSecret: (secret: SecretValue) => Promise<string>;
}): Promise<ReadonlyMap<string, Buffer>> {
	if (props.portalConfig.externalAuth !== undefined) {
		const masterKey = decodePortalMasterKey(
			await props.resolveSecret(props.portalConfig.externalAuth.masterKey),
		);
		return deriveApprovalHmacKeysFromMasterKey({ agentIds: props.agentIds, masterKey });
	}
	return await resolveAgentHmacKeys({
		agents: props.portalConfig.agents,
		envKeys: parseHmacKeysFromEnv(props.env),
		resolveSecret: props.resolveSecret,
	});
}

async function runCallCommand(
	command: Extract<McpPortalCommand, { readonly command: 'call' }>,
	runtimeProps: RequiredPortalRuntimeProps,
): Promise<number> {
	const { agentId, configDir, inputPath, toolName } = command;
	const input = JSON.parse(await readFile(inputPath, 'utf8')) as unknown;
	const secretResolver = await createCliSecretResolver(runtimeProps);
	const resolveSecret = (secret: SecretValue): Promise<string> =>
		resolveSecretValue(secret, { env: runtimeProps.env, secretResolver });
	const [mcpConfig, portalConfig] = await Promise.all([
		loadMcpConfig(join(configDir, 'mcp.config.jsonc')),
		loadMcpPortalConfig(join(configDir, 'mcp-portal.config.jsonc')),
	]);
	if (portalConfig.agents[agentId] === undefined) {
		throw new Error(`Unknown MCP Portal agent "${agentId}".`);
	}
	const hmacKeys = await resolveCliApprovalHmacKeys({
		agentIds: Object.keys(portalConfig.agents),
		env: runtimeProps.env,
		portalConfig,
		resolveSecret,
	});
	const agentRecords = createPortalAgentRuntimeRecords({ hmacKeys, portalConfig });
	const verifyApproval = createPortalApprovalVerifier({ records: agentRecords });
	const upstreamServers = await resolveUpstreamServers({ config: mcpConfig, resolveSecret });
	const upstreamRuntime = createUpstreamMcpClientRuntime({ servers: upstreamServers });
	const profilePolicyMaps = buildProfilePolicyMaps(portalConfig);
	const core = createPortalCore({
		accessPolicy: {
			defaultPolicy: 'deny-all',
			enabledNamespacesByAgent: profilePolicyMaps.enabledNamespacesByAgent,
			enabledToolsByNamespaceByAgent: profilePolicyMaps.enabledToolsByNamespaceByAgent,
			hiddenToolsByAgent: profilePolicyMaps.hiddenToolsByAgent,
		},
		approval: (calls, scope, approvalToken) => verifyApproval(calls, scope.agentId, approvalToken),
		catalogTtlMs: profilePolicyMaps.cacheTtlMs,
		runtime: {
			...upstreamRuntime,
			callUpstreamTool: upstreamRuntime.callTool,
		},
		upstreamNamespaces: upstreamServers.map((server) => server.namespace),
	});
	try {
		const scope = core.createAgentScope({
			agentId,
			agentScopeId: agentId,
			source: 'cli-operator',
		});
		const result = await core.collectPortalCoreResult(core.callStream({ input, scope, toolName }), {
			onEvent: writePortalCoreEventToStderr,
		});
		process.stdout.write(`${JSON.stringify(result, null, '\t')}\n`);
		return 0;
	} finally {
		await core.close();
	}
}

function assertNever(command: never): never {
	void command;
	throw new Error('Unhandled MCP Portal command.');
}

export async function runMcpPortalCommand(
	command: McpPortalCommand,
	props: AgentVmMcpPortalRuntimeProps = {},
): Promise<number> {
	const runtimeProps = {
		env: props.env ?? process.env,
		...(props.secretResolver !== undefined ? { secretResolver: props.secretResolver } : {}),
	};

	try {
		switch (command.command) {
			case 'call':
				return await runCallCommand(command, runtimeProps);
			case 'generate-helper': {
				const catalog = await readCatalogFile(command.catalogPath);
				await mkdir(command.outputDirectory, { recursive: true });
				await writeFile(
					join(command.outputDirectory, 'catalog.json'),
					JSON.stringify(catalog, null, '\t'),
				);
				await writeFile(
					join(command.outputDirectory, 'catalog.ts'),
					generateTypescriptCatalogArtifact(catalog),
				);
				return 0;
			}
			case 'mcp-proxy.print-client-config':
				return await printClientConfig(command, runtimeProps);
			case 'mcp-proxy.serve': {
				const injectedSecretResolver = runtimeProps.secretResolver;
				const server = await startPortalServer({
					args:
						command.port === undefined
							? {
									agentOverrides: command.agentOverrides,
									configDir: command.configDir,
								}
							: {
									agentOverrides: command.agentOverrides,
									configDir: command.configDir,
									port: command.port,
								},
					env: runtimeProps.env,
					...(injectedSecretResolver !== undefined
						? {
								resolveSecret: (secret) =>
									resolveSecretValue(secret, {
										env: runtimeProps.env,
										secretResolver: injectedSecretResolver,
									}),
							}
						: {}),
				});
				await waitUntilPortalServerShutdown({ server });
				return 0;
			}
			case 'mcp-proxy.write-credential':
				return printDisabledCredentialWriter();
			case 'validate':
				await readCatalogFile(command.catalogPath);
				return 0;
			default:
				return assertNever(command);
		}
	} catch (error: unknown) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}
