#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
	loadMcpConfig,
	loadMcpPortalConfig,
	type McpPortalConfig,
	type SecretValue,
} from '@agent-vm/config-contracts';
import type { SecretResolver } from '@agent-vm/secret-management';
import { z } from 'zod';

import { portalToolRecordSchema, type PortalToolRecord } from '../catalog-types.js';
import {
	runMcpPortalCliParser,
	type McpPortalCommand,
	type CallCommand,
	type PrintClientConfigCommand,
} from '../cli/mcp-portal-cli-parser.js';
import {
	configureProcessLogging,
	type ConfigureProcessLoggingProps,
	type ProcessLoggingHandle,
} from '../cli/process-logging.js';
import {
	buildProfilePolicyMaps,
	createServeSecretResolver,
	deriveApprovalHmacKeysFromMasterKey,
	startPortalServer,
} from '../cli/serve-command.js';
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
	readonly configureProcessLogging?:
		| ((props: ConfigureProcessLoggingProps) => Promise<ProcessLoggingHandle>)
		| undefined;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly secretResolver?: SecretResolver;
}

async function readCatalogFile(catalogPath: string): Promise<PortalCatalogFile> {
	const rawCatalog = await readFile(catalogPath, 'utf-8');
	const parsedJson = JSON.parse(rawCatalog) as unknown;
	return catalogFileSchema.parse(parsedJson);
}

function normalizeCredentialProxyUrl(value: string): string {
	const url = new URL(value);
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`Invalid --proxy-url protocol "${url.protocol}". Expected http or https.`);
	}
	return url.toString();
}

type RequiredPortalRuntimeProps = Required<Pick<AgentVmMcpPortalRuntimeProps, 'env'>> &
	Pick<AgentVmMcpPortalRuntimeProps, 'configureProcessLogging' | 'secretResolver'>;

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
	command: PrintClientConfigCommand,
	runtimeProps: RequiredPortalRuntimeProps,
): Promise<number> {
	const { agentId, configDir, expectedFingerprint, proxyUrl: proxyUrlOverride } = command.options;
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
		proxyUrlOverride === undefined
			? credentialProxyUrlFromConfig(requireCredentialMcpProxy(portalConfig.mcpProxy), agentId)
			: normalizeCredentialProxyUrl(proxyUrlOverride);
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

function assertNever(value: never): never {
	void value;
	throw new Error('Unhandled MCP Portal command.');
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
	readonly on: (signal: PortalShutdownSignal, listener: () => void) => void;
}

export interface RunningPortalServer {
	readonly close: () => Promise<void>;
}

export async function waitUntilPortalServerShutdown(props: {
	readonly onShutdownComplete?: () => Promise<void>;
	readonly server: RunningPortalServer;
	readonly signalTarget?: PortalSignalTarget;
}): Promise<void> {
	const signalTarget = props.signalTarget ?? process;
	const signals = ['SIGINT', 'SIGTERM'] satisfies readonly PortalShutdownSignal[];
	const listeners = new Map<PortalShutdownSignal, () => void>();
	let closePromise: Promise<void> | undefined;
	const closeServer = (): Promise<void> => {
		closePromise ??= Promise.resolve().then(() => props.server.close());
		return closePromise;
	};
	const shutdownPromise = new Promise<void>((resolve, reject) => {
		for (const signal of signals) {
			const listener = (): void => {
				void closeServer().then(resolve, reject);
			};
			listeners.set(signal, listener);
			signalTarget.on(signal, listener);
		}
	});
	let closeFailure: { readonly error: unknown } | undefined;
	let completionFailure: { readonly error: unknown } | undefined;
	try {
		try {
			await shutdownPromise;
		} catch (error: unknown) {
			closeFailure = { error };
		}
		try {
			await props.onShutdownComplete?.();
		} catch (error: unknown) {
			completionFailure = { error };
		}
	} finally {
		for (const [signal, listener] of listeners) {
			signalTarget.off(signal, listener);
		}
	}
	if (closeFailure !== undefined) {
		throw closeFailure.error;
	}
	if (completionFailure !== undefined) {
		throw completionFailure.error;
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
	command: CallCommand,
	runtimeProps: RequiredPortalRuntimeProps,
): Promise<number> {
	const { agentId, configDir, inputPath, toolName } = command.options;
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

async function dispatchMcpPortalCommand(
	command: McpPortalCommand,
	runtimeProps: RequiredPortalRuntimeProps,
): Promise<number> {
	switch (command.command) {
		case 'call':
			return await runCallCommand(command, runtimeProps);
		case 'generate-helper': {
			const catalog = await readCatalogFile(command.options.catalogPath);
			await mkdir(command.options.outputDirectory, { recursive: true });
			await writeFile(
				join(command.options.outputDirectory, 'catalog.json'),
				JSON.stringify(catalog, null, '\t'),
			);
			await writeFile(
				join(command.options.outputDirectory, 'catalog.ts'),
				generateTypescriptCatalogArtifact(catalog),
			);
			return 0;
		}
		case 'mcp-proxy.print-client-config':
			return await printClientConfig(command, runtimeProps);
		case 'mcp-proxy.serve': {
			let logging: ProcessLoggingHandle;
			try {
				const configureLogging = runtimeProps.configureProcessLogging ?? configureProcessLogging;
				logging = await configureLogging({ stderr: process.stderr });
			} catch {
				throw new Error('mcp-portal: process logging setup failed.');
			}
			let loggingShutdownAttempted = false;
			const shutdownLogging = async (): Promise<void> => {
				if (loggingShutdownAttempted) {
					return;
				}
				loggingShutdownAttempted = true;
				try {
					await logging.shutdown();
				} catch {
					process.stderr.write('mcp-portal: logging shutdown failed\n');
				}
			};
			try {
				const injectedSecretResolver = runtimeProps.secretResolver;
				const server = await startPortalServer({
					args: command.options,
					env: runtimeProps.env,
					...(injectedSecretResolver === undefined
						? {}
						: {
								resolveSecret: (secret) =>
									resolveSecretValue(secret, {
										env: runtimeProps.env,
										secretResolver: injectedSecretResolver,
									}),
							}),
				});
				await waitUntilPortalServerShutdown({ onShutdownComplete: shutdownLogging, server });
				return 0;
			} finally {
				await shutdownLogging();
			}
		}
		case 'mcp-proxy.write-credential':
			return printDisabledCredentialWriter();
		case 'validate':
			await readCatalogFile(command.options.catalogPath);
			return 0;
		default:
			return assertNever(command);
	}
}

export async function runMcpPortal(
	args: readonly string[],
	props: AgentVmMcpPortalRuntimeProps = {},
): Promise<number> {
	const runtimeProps = {
		env: props.env ?? process.env,
		...(props.configureProcessLogging === undefined
			? {}
			: { configureProcessLogging: props.configureProcessLogging }),
		...(props.secretResolver !== undefined ? { secretResolver: props.secretResolver } : {}),
	};
	const parseResult = runMcpPortalCliParser(args, {
		stderr: process.stderr,
		stdout: process.stdout,
	});
	if (parseResult.kind !== 'parsed') {
		return parseResult.exitCode;
	}

	try {
		return await dispatchMcpPortalCommand(parseResult.value, runtimeProps);
	} catch (error: unknown) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

/*
 * Command-shape note: top-level `serve` and credential commands are
 * intentionally rejected. The public CLI shape is `mcp-portal mcp-proxy ...`
 * so the command mirrors the library adapter boundary.
 */

export function shouldRunMcpPortalEntrypoint(argvPath: string | undefined): boolean {
	const entrypointName = argvPath === undefined ? undefined : basename(argvPath);
	return (
		entrypointName === 'mcp-portal' ||
		entrypointName === 'mcp-portal.js' ||
		entrypointName === 'mcp-portal.ts'
	);
}

if (shouldRunMcpPortalEntrypoint(process.argv[1])) {
	process.exitCode = await runMcpPortal(process.argv.slice(2));
}
