#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
	process.stderr.write('Usage: mcp-portal serve --config-dir <directory> [--port <port>]\n');
	process.stderr.write(
		'Usage: mcp-portal call --config-dir <directory> --agent <agent-id> --input <request.json> [--tool <portal-tool-name>]\n',
	);
	process.stderr.write(
		'Usage: mcp-portal write-credential --config-dir <directory> --agent <agent-id> --out <file> --master-key-fingerprint <sha256:...>\n',
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

async function writeFileAtomically(filePath: string, content: string): Promise<void> {
	const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await open(tempPath, 'wx', 0o600);
	try {
		await handle.writeFile(content, 'utf8');
		await handle.sync();
		await handle.close();
		await rename(tempPath, filePath);
	} catch (error) {
		await handle.close().catch(() => undefined);
		await rm(tempPath, { force: true });
		throw error;
	}
	await chmod(filePath, 0o600);
}

type RequiredPortalRuntimeProps = Required<Pick<AgentVmMcpPortalRuntimeProps, 'env'>> &
	Pick<AgentVmMcpPortalRuntimeProps, 'secretResolver'>;

async function createCliSecretResolver(props: RequiredPortalRuntimeProps): Promise<SecretResolver> {
	return props.secretResolver ?? (await createServeSecretResolver(props.env));
}

async function writeCredentialFile(
	args: readonly string[],
	runtimeProps: RequiredPortalRuntimeProps,
): Promise<number> {
	const configDir = readFlag(args, '--config-dir');
	const agentId = readFlag(args, '--agent');
	const outputPath = readFlag(args, '--out');
	const expectedFingerprint = readFlag(args, '--master-key-fingerprint');
	const proxyUrlOverride = readFlag(args, '--proxy-url');
	if (
		configDir === null ||
		agentId === null ||
		outputPath === null ||
		expectedFingerprint === null
	) {
		printUsage();
		return 1;
	}
	const portalConfig = await loadMcpPortalConfig(join(configDir, 'mcp-portal.config.jsonc'));
	if (portalConfig.externalAuth === undefined) {
		throw new Error('write-credential requires externalAuth.masterKey.');
	}
	if (portalConfig.mcpProxy === undefined && proxyUrlOverride === null) {
		throw new Error('write-credential requires mcpProxy server settings.');
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
	await writeFileAtomically(
		outputPath,
		`${JSON.stringify(
			{
				agentId,
				authorizationHeaderName,
				authorizationHeaderValue: `Bearer ${bearer}`,
				masterKeyFingerprint: actualFingerprint,
				proxyUrl,
				schemaVersion: 1,
			},
			null,
			'\t',
		)}\n`,
	);
	process.stderr.write(`wrote MCP Portal credential file ${outputPath}\n`);
	return 0;
}

function requireCredentialMcpProxy(
	mcpProxy: McpPortalConfig['mcpProxy'],
): NonNullable<McpPortalConfig['mcpProxy']> {
	if (mcpProxy === undefined) {
		throw new Error('write-credential requires mcpProxy server settings.');
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
		if (command === 'serve') {
			const injectedSecretResolver = runtimeProps.secretResolver;
			const server = await startPortalServer({
				args: parsePortalServerCliArgs(args.slice(1)),
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
		if (command === 'write-credential') {
			return await writeCredentialFile(args.slice(1), runtimeProps);
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

if (
	process.argv[1]?.endsWith('mcp-portal.js') === true ||
	process.argv[1]?.endsWith('mcp-portal.ts') === true
) {
	process.exitCode = await runMcpPortal(process.argv.slice(2));
}
