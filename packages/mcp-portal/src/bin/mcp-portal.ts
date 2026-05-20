#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
	loadMcpConfig,
	loadMcpPortalConfig,
	type McpPortalConfig,
	type SecretValue,
} from '@agent-vm/config-contracts';
import type { SecretResolver } from '@agent-vm/secrets';
import { z } from 'zod';

import { portalToolRecordSchema, type PortalToolRecord } from '../catalog-types.js';
import {
	buildProfilePolicyMaps,
	createServeSecretResolver,
	deriveApprovalHmacKeysFromMasterKey,
	parsePortalServerCliArgs,
	startPortalServer,
} from '../cli/serve-command.js';
import {
	createPortalCore,
	type PortalCoreEvent,
	type PortalCoreToolName,
} from '../core/portal-core.js';
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

function parseOutputDirectory(args: readonly string[]): string | null {
	const outputFlagIndex = args.indexOf('--out');
	if (outputFlagIndex === -1) {
		return null;
	}

	return args[outputFlagIndex + 1] ?? null;
}

function printUsage(): void {
	process.stderr.write('Usage: mcp-portal validate <catalog.json>\n');
	process.stderr.write('Usage: mcp-portal generate-helper <catalog.json> --out <directory>\n');
	process.stderr.write(
		'Usage: mcp-portal mcp-proxy serve --config-dir <directory> [--port <port>]\n',
	);
	process.stderr.write(
		'Usage: mcp-portal call --config-dir <directory> --agent <agent-id> --input <request.json> [--tool <portal-tool-name>]\n',
	);
	process.stderr.write(
		'Usage: mcp-portal mcp-proxy print-client-config --config-dir <directory> --agent <agent-id> --master-key-fingerprint <sha256:...> [--proxy-url <url>]\n',
	);
}

function readFlag(args: readonly string[], name: string): string | null {
	const index = args.indexOf(name);
	if (index === -1) {
		return null;
	}
	return args[index + 1] ?? null;
}

function normalizeCredentialProxyUrl(value: string): string {
	const url = new URL(value);
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`Invalid --proxy-url protocol "${url.protocol}". Expected http or https.`);
	}
	return url.toString();
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
	args: readonly string[],
	runtimeProps: RequiredPortalRuntimeProps,
): Promise<number> {
	const configDir = readFlag(args, '--config-dir');
	const agentId = readFlag(args, '--agent');
	const expectedFingerprint = readFlag(args, '--master-key-fingerprint');
	const proxyUrlOverride = readFlag(args, '--proxy-url');
	if (configDir === null || agentId === null || expectedFingerprint === null) {
		printUsage();
		return 1;
	}
	const portalConfig = await loadMcpPortalConfig(join(configDir, 'mcp-portal.config.jsonc'));
	if (portalConfig.externalAuth === undefined) {
		throw new Error('print-client-config requires externalAuth.masterKey.');
	}
	if (portalConfig.mcpProxy === undefined && proxyUrlOverride === null) {
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
		...(agentConfig.credentialVersion === undefined
			? {}
			: { credentialVersion: agentConfig.credentialVersion }),
		masterKey,
	});
	const proxyUrl =
		proxyUrlOverride === null
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
	return `http://${mcpProxy.server.host}:${String(mcpProxy.server.port)}/agents/${encodeURIComponent(agentId)}/mcp`;
}

const portalCoreToolNames = new Set<string>([
	'mcp_portal_list',
	'mcp_portal_search',
	'mcp_portal_describe',
	'mcp_portal_call',
]);

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

function isPortalCoreToolName(value: string): value is PortalCoreToolName {
	return portalCoreToolNames.has(value);
}

function parsePortalCoreToolName(value: string | null): PortalCoreToolName {
	const toolName = value ?? 'mcp_portal_call';
	if (!isPortalCoreToolName(toolName)) {
		throw new Error(`Unknown MCP Portal tool "${toolName}".`);
	}
	return toolName;
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
	args: readonly string[],
	runtimeProps: RequiredPortalRuntimeProps,
): Promise<number> {
	const configDir = readFlag(args, '--config-dir');
	const agentId = readFlag(args, '--agent');
	const inputPath = readFlag(args, '--input');
	if (configDir === null || agentId === null || inputPath === null) {
		printUsage();
		return 1;
	}
	const toolName = parsePortalCoreToolName(readFlag(args, '--tool'));
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
			enabledToolsByAgent: profilePolicyMaps.enabledToolsByAgent,
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

export async function runMcpPortal(
	args: readonly string[],
	props: AgentVmMcpPortalRuntimeProps = {},
): Promise<number> {
	const [command, catalogPath, ...restArgs] = args;
	const runtimeProps = {
		env: props.env ?? process.env,
		...(props.secretResolver !== undefined ? { secretResolver: props.secretResolver } : {}),
	};
	if (!command) {
		printUsage();
		return 1;
	}

	try {
		if (command === 'mcp-proxy') {
			const [mcpProxyCommand, ...mcpProxyArgs] = args.slice(1);
			if (mcpProxyCommand === 'serve') {
				const injectedSecretResolver = runtimeProps.secretResolver;
				const server = await startPortalServer({
					args: parsePortalServerCliArgs(mcpProxyArgs),
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
			if (mcpProxyCommand === 'write-credential') {
				return printDisabledCredentialWriter();
			}
			if (mcpProxyCommand === 'print-client-config') {
				return await printClientConfig(mcpProxyArgs, runtimeProps);
			}
			printUsage();
			return 1;
		}
		if (command === 'serve') {
			printUsage();
			return 1;
		}
		if (command === 'write-credential') {
			printUsage();
			return 1;
		}
		if (command === 'call') {
			return await runCallCommand(args.slice(1), runtimeProps);
		}
		if (!catalogPath) {
			printUsage();
			return 1;
		}
		const catalog = await readCatalogFile(catalogPath);
		switch (command) {
			case 'validate':
				return 0;
			case 'generate-helper': {
				const outputDirectory = parseOutputDirectory(restArgs);
				if (!outputDirectory) {
					printUsage();
					return 1;
				}

				await mkdir(outputDirectory, { recursive: true });
				await writeFile(join(outputDirectory, 'catalog.json'), JSON.stringify(catalog, null, '\t'));
				await writeFile(
					join(outputDirectory, 'catalog.ts'),
					generateTypescriptCatalogArtifact(catalog),
				);
				return 0;
			}
			default:
				printUsage();
				return 1;
		}
	} catch (error) {
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
