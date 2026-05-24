import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import {
	loadMcpConfig,
	loadMcpPortalConfig,
	resolveMcpPortalProfile,
	type McpPortalAgentConfig,
	type McpPortalConfig,
	type McpPortalExternalAuthConfig,
	type McpPortalProxyConfig,
	type ResolvedMcpPortalProfile,
	type SecretValue,
} from '@agent-vm/config-contracts';
import {
	createCompositeSecretResolver,
	createSecretResolver as createOnePasswordSecretResolver,
	resolveServiceAccountToken,
	type SecretResolver,
	type TokenSource,
} from '@agent-vm/secret-management';
import { serve } from '@hono/node-server';

import { resolveSecretValue } from '../bin/secret-value-resolver.js';
import { createPortalCore } from '../core/portal-core.js';
import { resolveUpstreamServers } from '../core/provider-runtime.js';
import { createPortalHttpApp, type PortalHttpAuditEvent } from '../mcp-proxy/portal-http-server.js';
import {
	createPortalAgentRuntimeRecords,
	createPortalApprovalVerifier,
	createPortalHttpAgentResolver,
	type PortalApprovalAuditEvent,
} from '../mcp-proxy/resolve-agent-identity.js';
import type { PortalToolSelector } from '../portal-access-policy.js';
import { decodePortalMasterKey } from '../portal-auth/agent-bearer-token.js';
import { createUpstreamMcpClientRuntime } from '../upstream-mcp-client-runtime.js';

type PortalNodeServer = ReturnType<typeof serve>;
type PortalServeFunction = typeof serve;

export type PortalServerLogEvent =
	| {
			readonly event: 'server_error';
			readonly level: 'error';
			readonly message: string;
			readonly stack?: string;
	  }
	| {
			readonly agentId: string;
			readonly clientAddress: string;
			readonly decision: PortalHttpAuditEvent['decision'];
			readonly event: 'mcp_proxy_auth';
			readonly level: 'info' | 'warn';
			readonly reason?: PortalHttpAuditEvent['reason'];
			readonly timeMs: number;
	  }
	| {
			readonly agentId: string;
			readonly clientAddress: string;
			readonly event: 'mcp_proxy_auth_audit_error';
			readonly level: 'warn';
			readonly message: string;
			readonly timeMs: number;
	  }
	| {
			readonly agentId: string;
			readonly decision: PortalApprovalAuditEvent['decision'];
			readonly event: 'mcp_portal_approval';
			readonly level: 'info' | 'warn';
			readonly reason?: PortalApprovalAuditEvent['reason'];
			readonly timeMs: number;
			readonly verifierReason?: string;
	  }
	| {
			readonly agentId: string;
			readonly event: 'mcp_portal_approval_audit_error';
			readonly level: 'warn';
			readonly message: string;
			readonly timeMs: number;
	  }
	| {
			readonly agentScopeId: string;
			readonly event: 'upstream_close_error';
			readonly level: 'warn';
			readonly message: string;
			readonly namespace?: string;
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

export interface CreateServeSecretResolverDependencies {
	readonly createOnePasswordSecretResolver?: typeof createOnePasswordSecretResolver;
	readonly resolveServiceAccountToken?: typeof resolveServiceAccountToken;
}

function requirePortalTokenSourceValue(
	env: Readonly<Record<string, string | undefined>>,
	name: string,
	sourceType: string,
): string {
	const value = env[name]?.trim();
	if (value === undefined || value.length === 0) {
		throw new Error(`${name} is required when AGENT_VM_MCP_PORTAL_OP_TOKEN_SOURCE=${sourceType}.`);
	}
	return value;
}

function readPortalOnePasswordTokenSource(
	env: Readonly<Record<string, string | undefined>>,
): TokenSource | null {
	const sourceType = env.AGENT_VM_MCP_PORTAL_OP_TOKEN_SOURCE?.trim();
	if (sourceType === undefined || sourceType.length === 0) {
		const configuredEnvVar = env.AGENT_VM_MCP_PORTAL_OP_TOKEN_ENV_VAR?.trim();
		const envVar =
			configuredEnvVar === undefined || configuredEnvVar.length === 0
				? 'OP_SERVICE_ACCOUNT_TOKEN'
				: configuredEnvVar;
		const token = env[envVar]?.trim();
		return token === undefined || token.length === 0 ? null : { envVar, type: 'env' };
	}

	if (sourceType === 'env') {
		return {
			envVar: requirePortalTokenSourceValue(
				env,
				'AGENT_VM_MCP_PORTAL_OP_TOKEN_ENV_VAR',
				sourceType,
			),
			type: 'env',
		};
	}
	if (sourceType === 'op-cli') {
		return {
			ref: requirePortalTokenSourceValue(env, 'AGENT_VM_MCP_PORTAL_OP_TOKEN_REF', sourceType),
			type: 'op-cli',
		};
	}
	if (sourceType === 'keychain') {
		return {
			account: requirePortalTokenSourceValue(
				env,
				'AGENT_VM_MCP_PORTAL_OP_TOKEN_KEYCHAIN_ACCOUNT',
				sourceType,
			),
			service: requirePortalTokenSourceValue(
				env,
				'AGENT_VM_MCP_PORTAL_OP_TOKEN_KEYCHAIN_SERVICE',
				sourceType,
			),
			type: 'keychain',
		};
	}

	throw new Error(`Unsupported AGENT_VM_MCP_PORTAL_OP_TOKEN_SOURCE "${sourceType}".`);
}

async function resolvePortalServiceAccountToken(props: {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly resolveToken: typeof resolveServiceAccountToken;
	readonly tokenSource: TokenSource;
}): Promise<string> {
	if (props.tokenSource.type !== 'env') {
		return await props.resolveToken(props.tokenSource);
	}
	const envVar = props.tokenSource.envVar ?? 'OP_SERVICE_ACCOUNT_TOKEN';
	const token = props.env[envVar]?.trim();
	if (token === undefined || token.length === 0) {
		throw new Error(`Environment variable ${envVar} is not set`);
	}
	return token;
}

export async function createServeSecretResolver(
	env: Readonly<Record<string, string | undefined>>,
	dependencies: CreateServeSecretResolverDependencies = {},
): Promise<SecretResolver> {
	const tokenSource = readPortalOnePasswordTokenSource(env);
	const resolveToken = dependencies.resolveServiceAccountToken ?? resolveServiceAccountToken;
	const createResolver =
		dependencies.createOnePasswordSecretResolver ?? createOnePasswordSecretResolver;
	const onePasswordResolver =
		tokenSource === null
			? null
			: await createResolver({
					serviceAccountToken: await resolvePortalServiceAccountToken({
						env,
						resolveToken,
						tokenSource,
					}),
				});
	return createCompositeSecretResolver(onePasswordResolver, env);
}

export interface ProfilePolicyMaps {
	readonly enabledNamespacesByAgent: Readonly<Record<string, readonly string[]>>;
	readonly enabledToolsByNamespaceByAgent: Readonly<
		Record<string, Readonly<Record<string, readonly string[]>>>
	>;
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

function selectorsFromNamespaceTools(
	namespaceTools: Readonly<Record<string, readonly string[]>>,
): readonly PortalToolSelector[] {
	return Object.entries(namespaceTools).flatMap(([namespace, toolNames]) =>
		toolNames.map((toolName) => ({ namespace, toolName })),
	);
}

export function buildProfilePolicyMaps(
	portalConfig: McpPortalConfig,
): ProfilePolicyMaps & { readonly cacheTtlMs: number } {
	const enabledNamespacesByAgent: Record<string, readonly string[]> = {};
	const enabledToolsByNamespaceByAgent: Record<
		string,
		Readonly<Record<string, readonly string[]>>
	> = {};
	const hiddenToolsByAgent: Record<string, readonly PortalToolSelector[]> = {};
	const profileTtls: number[] = [];

	for (const [agentId, agent] of Object.entries(portalConfig.agents)) {
		const profile: ResolvedMcpPortalProfile = resolveMcpPortalProfile(portalConfig, agent.profile);
		enabledNamespacesByAgent[agentId] = profile.enabledNamespaces;
		enabledToolsByNamespaceByAgent[agentId] = profile.enabledToolsByNamespace;
		hiddenToolsByAgent[agentId] = selectorsFromNamespaceTools(profile.hiddenToolsByNamespace);
		profileTtls.push(profile.cache.catalogTtlMs);
	}

	return {
		cacheTtlMs: profileTtls.length === 0 ? 60_000 : Math.min(...profileTtls),
		enabledNamespacesByAgent,
		enabledToolsByNamespaceByAgent,
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

function requireProxyConfig(portalConfig: McpPortalConfig): {
	readonly externalAuth: McpPortalExternalAuthConfig;
	readonly mcpProxy: McpPortalProxyConfig;
} {
	if (portalConfig.externalAuth === undefined || portalConfig.mcpProxy === undefined) {
		throw new Error(
			'mcp-proxy startup requires mcp-portal.config.jsonc externalAuth.masterKey and mcpProxy settings.',
		);
	}
	return {
		externalAuth: portalConfig.externalAuth,
		mcpProxy: portalConfig.mcpProxy,
	};
}

export function deriveApprovalHmacKeysFromMasterKey(props: {
	readonly agentIds: readonly string[];
	readonly masterKey: Buffer;
}): ReadonlyMap<string, Buffer> {
	return new Map(
		props.agentIds.map((agentId) => [
			agentId,
			createHmac('sha256', props.masterKey).update(`mcp-portal:approval-agent:${agentId}`).digest(),
		]),
	);
}

function credentialVersionsByAgent(
	portalConfig: McpPortalConfig,
): Readonly<Record<string, number>> {
	return Object.fromEntries(
		Object.entries(portalConfig.agents).map(([agentId, agent]) => [
			agentId,
			agent.credentialVersion,
		]),
	);
}

export async function startPortalServer(
	props: StartPortalServerProps,
): Promise<{ readonly close: () => Promise<void>; readonly port: number }> {
	const logger = props.logger ?? defaultPortalServerLogger();
	const serveFn = props.serveFn ?? serve;
	let defaultSecretResolverPromise: Promise<SecretResolver> | undefined;
	const getDefaultSecretResolver = (): Promise<SecretResolver> => {
		defaultSecretResolverPromise ??= createServeSecretResolver(props.env);
		return defaultSecretResolverPromise;
	};
	const resolveSecret =
		props.resolveSecret ??
		(async (secret: SecretValue) =>
			resolveSecretValue(secret, {
				env: props.env,
				secretResolver: await getDefaultSecretResolver(),
			}));
	const mcpConfig = await loadMcpConfig(join(props.args.configDir, 'mcp.config.jsonc'));
	const portalConfig = withAgentOverrides(
		await loadMcpPortalConfig(join(props.args.configDir, 'mcp-portal.config.jsonc')),
		props.args.agentOverrides,
	);
	const proxyStartup = requireProxyConfig(portalConfig);
	const masterKey = decodePortalMasterKey(await resolveSecret(proxyStartup.externalAuth.masterKey));
	const hmacKeys = deriveApprovalHmacKeysFromMasterKey({
		agentIds: Object.keys(portalConfig.agents),
		masterKey,
	});
	const agentRecords = createPortalAgentRuntimeRecords({ hmacKeys, portalConfig });
	const upstreamServers = await resolveUpstreamServers({ config: mcpConfig, resolveSecret });
	const upstreamRuntime = createUpstreamMcpClientRuntime({
		additionalRedactionValues: [masterKey.toString('base64url')],
		onCloseError: (error, context) => {
			logger.log({
				agentScopeId: context.agentScopeId,
				event: 'upstream_close_error',
				level: 'warn',
				message: error.message,
				...(context.namespace === undefined ? {} : { namespace: context.namespace }),
			});
		},
		servers: upstreamServers,
	});
	const profilePolicyMaps = buildProfilePolicyMaps(portalConfig);
	const verifyApproval = createPortalApprovalVerifier({
		auditErrorSink: (error, event) => {
			logger.log({
				agentId: event.agentId,
				event: 'mcp_portal_approval_audit_error',
				level: 'warn',
				message: error.message,
				timeMs: event.timeMs,
			});
		},
		auditSink: (event) => {
			logger.log({
				agentId: event.agentId,
				decision: event.decision,
				event: 'mcp_portal_approval',
				level: event.decision === 'allow' ? 'info' : 'warn',
				...('reason' in event ? { reason: event.reason } : {}),
				timeMs: event.timeMs,
				...('verifierReason' in event ? { verifierReason: event.verifierReason } : {}),
			});
		},
		records: agentRecords,
	});
	const core = createPortalCore({
		accessPolicy: {
			defaultPolicy: 'deny-all',
			enabledNamespacesByAgent: profilePolicyMaps.enabledNamespacesByAgent,
			enabledToolsByNamespaceByAgent: profilePolicyMaps.enabledToolsByNamespaceByAgent,
			hiddenToolsByAgent: profilePolicyMaps.hiddenToolsByAgent,
		},
		approval: (calls, identity, approvalToken) =>
			verifyApproval(calls, identity.agentId, approvalToken),
		catalogTtlMs: profilePolicyMaps.cacheTtlMs,
		runtime: {
			...upstreamRuntime,
			callUpstreamTool: upstreamRuntime.callTool,
		},
		upstreamNamespaces: upstreamServers.map((server) => server.namespace),
	});
	const app = createPortalHttpApp({
		agentBearerAuth: {
			authorizationHeaderName: proxyStartup.mcpProxy.auth.headerName,
			credentialVersionsByAgent: credentialVersionsByAgent(portalConfig),
			masterKey,
		},
		auditSink: (event) => {
			logger.log({
				agentId: event.agentId,
				clientAddress: event.clientAddress,
				decision: event.decision,
				event: 'mcp_proxy_auth',
				level: event.decision === 'allow' ? 'info' : 'warn',
				...(event.reason === undefined ? {} : { reason: event.reason }),
				timeMs: event.timeMs,
			});
		},
		auditErrorSink: (error, event) => {
			logger.log({
				agentId: event.agentId,
				clientAddress: event.clientAddress,
				event: 'mcp_proxy_auth_audit_error',
				level: 'warn',
				message: error.message,
				timeMs: event.timeMs,
			});
		},
		core,
		onSessionClosed: async (identity) => {
			await core.invalidateSession(identity);
		},
		registeredAgentIds: Object.keys(portalConfig.agents),
		resolveAgentIdentity: createPortalHttpAgentResolver(agentRecords),
	});
	const listeningPort = createDeferredPort();
	let hasListened = false;
	const server = serveFn(
		{
			fetch: app.fetch,
			hostname: proxyStartup.mcpProxy.server.host,
			port: props.args.port ?? proxyStartup.mcpProxy.server.port,
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
			await core.close();
			await closeNodeServer(server);
		},
		port,
	};
}
