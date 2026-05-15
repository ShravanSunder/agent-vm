#!/usr/bin/env node
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import {
	loadMcpConfig,
	loadMcpPortalConfig,
	mcpConfigToResolvedProviders,
	resolveMcpPortalProfile,
	type McpConfig,
	type McpPortalAgentConfig,
	type McpPortalConfig,
	type ResolvedMcpProvider,
	type ResolvedMcpPortalProfile,
	type SecretValue,
} from '@agent-vm/config-contracts';
import { serve } from '@hono/node-server';

import { parseHmacKeysFromEnv } from '../auth/hmac-env.js';
import { createPortalHttpApp } from '../mcp-server/portal-http-server.js';
import {
	createPortalAgentRuntimeRecords,
	createPortalApprovalVerifier,
	createPortalHttpAgentResolver,
	resolveAgentHmacKeys,
} from '../mcp-server/resolve-agent-identity.js';
import type { PortalToolSelector } from '../portal-access-policy.js';
import { createPortalSessionManager } from '../portal-session.js';
import {
	createUpstreamMcpClientRuntime,
	type NormalizedUpstreamMcpServer,
} from '../upstream-mcp-client-runtime.js';
import { resolveSecretValue } from './secret-value-resolver.js';

type PortalNodeServer = ReturnType<typeof serve>;
type PortalServeFunction = typeof serve;

export type PortalServerLogEvent =
	| {
			readonly agentId: string;
			readonly conservativeCallCount: number;
			readonly event: 'conservative_approval_fallback';
			readonly level: 'warn';
			readonly primaryReason: string;
			readonly strictCallCount: number;
			readonly toolRefs: readonly string[];
	  }
	| {
			readonly event: 'server_error';
			readonly level: 'error';
			readonly message: string;
			readonly stack?: string;
	  };

export interface PortalServerLogger {
	readonly log: (event: PortalServerLogEvent) => void;
}

export interface PortalServerCliArgs {
	readonly agentOverrides: readonly string[];
	readonly configDir: string;
	readonly port?: number;
}

export interface StartPortalServerProps {
	readonly args: PortalServerCliArgs;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly logger?: PortalServerLogger;
	readonly resolveSecret?: (secret: SecretValue) => Promise<string>;
	readonly serveFn?: PortalServeFunction;
}

interface ProfilePolicyMaps {
	readonly enabledNamespacesByAgent: Readonly<Record<string, readonly string[]>>;
	readonly enabledToolsByAgent: Readonly<Record<string, readonly PortalToolSelector[]>>;
	readonly hiddenToolsByAgent: Readonly<Record<string, readonly PortalToolSelector[]>>;
}

function parsePort(value: string | undefined): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`Invalid --port value "${value}".`);
	}
	return port;
}

export function parsePortalServerCliArgs(argv: readonly string[]): PortalServerCliArgs {
	const parsed = parseArgs({
		args: [...argv],
		options: {
			agent: { multiple: true, type: 'string' },
			'config-dir': { type: 'string' },
			port: { short: 'p', type: 'string' },
		},
		strict: true,
	});
	const configDir = parsed.values['config-dir'];
	if (typeof configDir !== 'string' || configDir.length === 0) {
		throw new Error('--config-dir <path> is required.');
	}
	const rawAgentOverrides = parsed.values.agent;
	const args = {
		agentOverrides: Array.isArray(rawAgentOverrides) ? rawAgentOverrides : [],
		configDir,
	};
	const port = parsePort(parsed.values.port);
	return port === undefined ? args : { ...args, port };
}

export function applyAgentOverrides(
	agents: Readonly<Record<string, McpPortalAgentConfig>>,
	overrides: readonly string[],
): Readonly<Record<string, McpPortalAgentConfig>> {
	const nextAgents: Record<string, McpPortalAgentConfig> = { ...agents };
	for (const override of overrides) {
		const [agentId, profileName, extra] = override.split('=');
		if (
			agentId === undefined ||
			profileName === undefined ||
			extra !== undefined ||
			agentId.length === 0 ||
			profileName.length === 0
		) {
			throw new Error(`Invalid --agent override "${override}". Expected <agentId>=<profile>.`);
		}
		const existingAgent = nextAgents[agentId];
		if (existingAgent === undefined) {
			throw new Error(`Cannot override unknown MCP Portal agent "${agentId}".`);
		}
		nextAgents[agentId] = { ...existingAgent, profile: profileName };
	}
	return nextAgents;
}

export interface DeferredPort {
	readonly promise: Promise<number>;
	readonly reject: (error: Error) => void;
	readonly resolve: (port: number) => void;
}

function createDeferredPort(): DeferredPort {
	let rejectPort: ((error: Error) => void) | undefined;
	let resolvePort: ((port: number) => void) | undefined;
	const promise = new Promise<number>((resolve, reject) => {
		rejectPort = reject;
		resolvePort = resolve;
	});
	return {
		promise,
		reject: (error) => {
			if (rejectPort === undefined) {
				throw new Error('MCP Portal port rejector was not initialized.');
			}
			rejectPort(error);
		},
		resolve: (port) => {
			if (resolvePort === undefined) {
				throw new Error('MCP Portal port resolver was not initialized.');
			}
			resolvePort(port);
		},
	};
}

function defaultPortalServerLogger(): PortalServerLogger {
	return {
		log: (event) => {
			process.stderr.write(`${JSON.stringify(event)}\n`);
		},
	};
}

export function handlePortalServerError(props: {
	readonly error: Error;
	readonly hasListened: boolean;
	readonly listeningPort: DeferredPort;
	readonly logger: PortalServerLogger;
}): void {
	props.logger.log({
		event: 'server_error',
		level: 'error',
		message: props.error.message,
		...(props.error.stack === undefined ? {} : { stack: props.error.stack }),
	});
	if (!props.hasListened) {
		props.listeningPort.reject(props.error);
	}
}

function closeNodeServer(server: PortalNodeServer): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		});
	});
}

async function resolveProviderSecretRecord(
	secrets: Readonly<Record<string, SecretValue>>,
	resolveSecret: (secret: SecretValue) => Promise<string>,
): Promise<Readonly<Record<string, string>>> {
	const resolvedEntries = await Promise.all(
		Object.entries(secrets).map(
			async ([name, secret]) => [name, await resolveSecret(secret)] as const,
		),
	);
	return Object.fromEntries(resolvedEntries);
}

async function resolveUpstreamServer(
	provider: ResolvedMcpProvider,
	resolveSecret: (secret: SecretValue) => Promise<string>,
): Promise<NormalizedUpstreamMcpServer> {
	if (provider.transport === 'stdio') {
		return {
			args: provider.args,
			command: provider.command,
			...(provider.cwd === undefined ? {} : { cwd: provider.cwd }),
			env: await resolveProviderSecretRecord(provider.env, resolveSecret),
			namespace: provider.namespace,
			transport: 'stdio',
		};
	}

	return {
		headers: await resolveProviderSecretRecord(provider.headers, resolveSecret),
		namespace: provider.namespace,
		transport: provider.transport,
		url: provider.url,
	};
}

async function resolveUpstreamServers(
	mcpConfig: McpConfig,
	resolveSecret: (secret: SecretValue) => Promise<string>,
): Promise<readonly NormalizedUpstreamMcpServer[]> {
	return await Promise.all(
		mcpConfigToResolvedProviders(mcpConfig).map(async (provider) =>
			resolveUpstreamServer(provider, resolveSecret),
		),
	);
}

function selectorsFromNamespaceTools(
	namespaceTools: Readonly<Record<string, readonly string[]>>,
): readonly PortalToolSelector[] {
	return Object.entries(namespaceTools).flatMap(([namespace, toolNames]) =>
		toolNames.map((toolName) => ({ namespace, toolName })),
	);
}

function buildProfilePolicyMaps(
	portalConfig: McpPortalConfig,
): ProfilePolicyMaps & { readonly cacheTtlMs: number } {
	const enabledNamespacesByAgent: Record<string, readonly string[]> = {};
	const enabledToolsByAgent: Record<string, readonly PortalToolSelector[]> = {};
	const hiddenToolsByAgent: Record<string, readonly PortalToolSelector[]> = {};
	const profileTtls: number[] = [];

	for (const [agentId, agent] of Object.entries(portalConfig.agents)) {
		const profile: ResolvedMcpPortalProfile = resolveMcpPortalProfile(portalConfig, agent.profile);
		enabledNamespacesByAgent[agentId] = profile.enabledNamespaces;
		enabledToolsByAgent[agentId] = selectorsFromNamespaceTools(profile.enabledToolsByNamespace);
		hiddenToolsByAgent[agentId] = selectorsFromNamespaceTools(profile.hiddenToolsByNamespace);
		profileTtls.push(profile.cache.catalogTtlMs);
	}

	return {
		cacheTtlMs: profileTtls.length === 0 ? 60_000 : Math.min(...profileTtls),
		enabledNamespacesByAgent,
		enabledToolsByAgent,
		hiddenToolsByAgent,
	};
}

function withAgentOverrides(
	portalConfig: McpPortalConfig,
	agentOverrides: readonly string[],
): McpPortalConfig {
	return {
		...portalConfig,
		agents: applyAgentOverrides(portalConfig.agents, agentOverrides),
	};
}

export async function startPortalServer(
	props: StartPortalServerProps,
): Promise<{ readonly close: () => Promise<void>; readonly port: number }> {
	const logger = props.logger ?? defaultPortalServerLogger();
	const serveFn = props.serveFn ?? serve;
	const resolveSecret =
		props.resolveSecret ??
		((secret: SecretValue) => resolveSecretValue(secret, { env: props.env }));
	const mcpConfig = await loadMcpConfig(join(props.args.configDir, 'mcp.config.jsonc'));
	const portalConfig = withAgentOverrides(
		await loadMcpPortalConfig(join(props.args.configDir, 'mcp-portal.config.jsonc')),
		props.args.agentOverrides,
	);
	const serverAccessSecret = await resolveSecret(portalConfig.server.accessHeader.secret);
	const hmacKeys = await resolveAgentHmacKeys({
		agents: portalConfig.agents,
		envKeys: parseHmacKeysFromEnv(props.env),
		resolveSecret,
	});
	const agentRecords = createPortalAgentRuntimeRecords({ hmacKeys, portalConfig });
	const upstreamServers = await resolveUpstreamServers(mcpConfig, resolveSecret);
	const upstreamRuntime = createUpstreamMcpClientRuntime({ servers: upstreamServers });
	const profilePolicyMaps = buildProfilePolicyMaps(portalConfig);
	const sessionManager = createPortalSessionManager({
		accessPolicy: {
			defaultPolicy: 'deny-all',
			enabledNamespacesByAgent: profilePolicyMaps.enabledNamespacesByAgent,
			enabledToolsByAgent: profilePolicyMaps.enabledToolsByAgent,
			hiddenToolsByAgent: profilePolicyMaps.hiddenToolsByAgent,
		},
		catalogTtlMs: profilePolicyMaps.cacheTtlMs,
		runtime: upstreamRuntime,
		upstreamNamespaces: upstreamServers.map((server) => server.namespace),
	});
	const verifyApproval = createPortalApprovalVerifier({
		onConservativeApprovalFallback: (event) => {
			logger.log({
				agentId: event.agentId,
				conservativeCallCount: event.conservativeCallCount,
				event: 'conservative_approval_fallback',
				level: 'warn',
				primaryReason: event.primaryReason,
				strictCallCount: event.strictCallCount,
				toolRefs: event.toolRefs,
			});
		},
		records: agentRecords,
	});
	const app = createPortalHttpApp({
		onSessionClosed: async (identity) => {
			await sessionManager.invalidateSession(identity);
		},
		registeredAgentIds: Object.keys(portalConfig.agents),
		resolveAgentIdentity: createPortalHttpAgentResolver(agentRecords),
		serverAccess: {
			expectedValue: serverAccessSecret,
			headerName: portalConfig.server.accessHeader.name,
		},
		toolRuntime: {
			approval: (calls, identity, approvalToken) =>
				verifyApproval(calls, identity.agentId, approvalToken),
			callUpstreamTool: upstreamRuntime.callTool,
			getSession: sessionManager.getSession,
		},
	});
	const listeningPort = createDeferredPort();
	let hasListened = false;
	const server = serveFn(
		{
			fetch: app.fetch,
			hostname: portalConfig.server.host,
			port: props.args.port ?? portalConfig.server.port,
		},
		(info) => {
			hasListened = true;
			process.stdout.write(`listening port=${String(info.port)}\n`);
			listeningPort.resolve(info.port);
		},
	);
	server.on('error', (error: Error) => {
		handlePortalServerError({ error, hasListened, listeningPort, logger });
	});
	const port = await listeningPort.promise;

	return {
		close: async () => {
			await app.closePortalSessions();
			await Promise.all(
				Object.keys(portalConfig.agents).map((agentId) =>
					sessionManager.invalidateAgentScope(agentId),
				),
			);
			await closeNodeServer(server);
		},
		port,
	};
}

async function main(): Promise<void> {
	const startedServer = await startPortalServer({
		args: parsePortalServerCliArgs(process.argv.slice(2)),
		env: process.env,
	});
	const shutdown = async (): Promise<void> => {
		await startedServer.close();
		process.exit(0);
	};
	process.on('SIGINT', () => {
		void shutdown();
	});
	process.on('SIGTERM', () => {
		void shutdown();
	});
}

if (import.meta.url === `file://${process.argv[1]}`) {
	void main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}
