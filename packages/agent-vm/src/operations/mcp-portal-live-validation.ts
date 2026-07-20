import path from 'node:path';

import {
	loadMcpConfig,
	loadToolPortalConfig,
	type SecretValue,
	type ToolPortalConfig,
	type ToolPortalProfileDefinition,
	type ToolPortalToolSelector,
} from '@agent-vm/config-contracts';
import {
	assertJsonObject,
	buildZodValidatorFromJsonSchema,
	createUpstreamMcpClientRuntime,
	UpstreamMcpError,
} from '@agent-vm/mcp-portal';
import { resolveUpstreamServers } from '@agent-vm/mcp-portal/core';
import type { SecretRef, SecretResolver } from '@agent-vm/secret-management';

import type { LoadedSystemConfig } from '../config/system-config.js';
import {
	type ConfigValidationCheck,
	resolveProjectCheckoutPath,
} from './config-validation-shared.js';

export interface RunLiveMcpPortalValidationOptions {
	readonly createRuntime?: typeof createUpstreamMcpClientRuntime;
	readonly secretResolver: SecretResolver;
	readonly systemConfig: LoadedSystemConfig;
}

type LoadedZoneConfig = LoadedSystemConfig['zones'][number];

function secretRefFromSecretValue(secret: SecretValue): SecretRef {
	if (secret.source === 'environment') {
		return { ref: secret.name, source: 'environment' };
	}
	return { ref: secret.ref, source: '1password' };
}

async function resolveProviderSecret(
	secret: SecretValue,
	secretResolver: SecretResolver,
): Promise<string> {
	return await secretResolver.resolve(secretRefFromSecretValue(secret));
}

function requireToolPortalProfile(
	config: ToolPortalConfig,
	profileId: string,
): ToolPortalProfileDefinition {
	const profile = config.profiles[profileId];
	if (profile === undefined) {
		throw new Error(`Tool Portal profile '${profileId}' is not configured.`);
	}
	return profile;
}

function profileNamespaces(profile: ToolPortalProfileDefinition): readonly string[] {
	return Object.entries(profile.namespaces)
		.filter(([, namespacePolicy]) => namespacePolicy.backend.kind === 'mcp_provider')
		.map(([namespace]) => namespace)
		.toSorted();
}

function selectorToolNames(selector: ToolPortalToolSelector): readonly string[] {
	return selector.allow === '*' ? selector.deny : [...selector.allow, ...selector.deny];
}

function profileToolNamesForNamespace(
	profile: ToolPortalProfileDefinition,
	namespace: string,
): readonly string[] {
	const namespacePolicy = profile.namespaces[namespace];
	if (namespacePolicy === undefined || namespacePolicy.backend.kind !== 'mcp_provider') {
		return [];
	}
	return Array.from(
		new Set([
			...selectorToolNames(namespacePolicy.tools),
			...selectorToolNames(namespacePolicy.calls.requiresApproval),
			...selectorToolNames(namespacePolicy.calls.withoutApproval),
		]),
	).toSorted();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatTransportHint(transport: UpstreamMcpError['details']['transport']): string {
	if (transport.kind === 'stdio') {
		return `transport=stdio command=${transport.command} argCount=${String(transport.argCount)}`;
	}
	return `transport=${transport.kind} url=${transport.url}`;
}

function validationHintForError(error: unknown): string {
	if (!(error instanceof UpstreamMcpError)) {
		return errorMessage(error);
	}
	const details = error.details;
	return [
		`${details.namespace} ${details.phase}: ${details.causeMessage}`,
		formatTransportHint(details.transport),
		details.hint,
	].join('; ');
}

function validateLiveToolSchemas(options: {
	readonly namespace: string;
	readonly tools: Awaited<
		ReturnType<ReturnType<typeof createUpstreamMcpClientRuntime>['listTools']>
	>;
	readonly zoneId: string;
}): readonly ConfigValidationCheck[] {
	return options.tools.flatMap((tool) => {
		try {
			const inputSchema = assertJsonObject(
				tool.inputSchema,
				`${options.namespace}.${tool.name} inputSchema`,
			);
			const validator = buildZodValidatorFromJsonSchema(inputSchema);
			if (validator.ok) {
				return [];
			}
			return [
				{
					hint: `${options.namespace}.${tool.name} input schema uses unsupported JSON Schema feature '${validator.error.feature}' at ${validator.error.path.join('.') || '<root>'}: ${validator.error.message}`,
					name: `mcp-live-tool-schema-${options.zoneId}-${options.namespace}-${tool.name}`,
					ok: false,
				} satisfies ConfigValidationCheck,
			];
		} catch (error) {
			return [
				{
					hint: `${options.namespace}.${tool.name} input schema is not a supported JSON object: ${errorMessage(error)}`,
					name: `mcp-live-tool-schema-${options.zoneId}-${options.namespace}-${tool.name}`,
					ok: false,
				} satisfies ConfigValidationCheck,
			];
		}
	});
}

function zoneConfigFailure(zoneId: string, error: unknown): readonly ConfigValidationCheck[] {
	return [
		{
			hint: errorMessage(error),
			name: `mcp-live-${zoneId}-config`,
			ok: false,
		},
	];
}

async function validateMcpPortalNamespace(props: {
	readonly agentScopeId: string;
	readonly namespace: string;
	readonly runtime: ReturnType<typeof createUpstreamMcpClientRuntime>;
	readonly toolPortalConfig: Awaited<ReturnType<typeof loadToolPortalConfig>>;
	readonly zoneId: string;
}): Promise<readonly ConfigValidationCheck[]> {
	try {
		const tools = await props.runtime.listTools({
			agentScopeId: props.agentScopeId,
			namespace: props.namespace,
		});
		const actualToolNames = new Set(tools.map((tool) => tool.name));
		const actualToolNameList = tools.map((tool) => tool.name).toSorted();
		const profileToolChecks = Object.entries(props.toolPortalConfig.agents).flatMap(
			([agentId, agent]) => {
				const profile = requireToolPortalProfile(props.toolPortalConfig, agent.profile);
				const configuredTools = profileToolNamesForNamespace(profile, props.namespace);
				const missingTools = configuredTools.filter((toolName) => !actualToolNames.has(toolName));
				if (missingTools.length === 0) {
					return [];
				}
				return [
					{
						hint: `Agent '${agentId}' profile '${agent.profile}' references missing ${props.namespace} tools: ${missingTools.join(', ')}. Actual tools: ${actualToolNameList.join(', ')}.`,
						name: `mcp-live-profile-tools-${props.zoneId}-${agentId}-${props.namespace}`,
						ok: false,
					} satisfies ConfigValidationCheck,
				];
			},
		);
		return [
			{
				hint: `${props.namespace} discovered ${String(tools.length)} tools.`,
				name: `mcp-live-${props.zoneId}-${props.namespace}`,
				ok: true,
				status: 'available',
			},
			...validateLiveToolSchemas({
				namespace: props.namespace,
				tools,
				zoneId: props.zoneId,
			}),
			...profileToolChecks,
		];
	} catch (error) {
		return [
			{
				hint: `${props.namespace} disabled/unavailable: ${validationHintForError(error)}`,
				name: `mcp-live-${props.zoneId}-${props.namespace}`,
				ok: false,
				status: 'unavailable',
			},
		];
	}
}

async function validateMcpPortalZone(
	options: RunLiveMcpPortalValidationOptions,
	zone: LoadedZoneConfig,
): Promise<readonly ConfigValidationCheck[]> {
	if (zone.gateway.type === 'worker' || zone.toolPortal === undefined) {
		return [];
	}
	let mcpConfig: Awaited<ReturnType<typeof loadMcpConfig>>;
	let servers: Awaited<ReturnType<typeof resolveUpstreamServers>>;
	let toolPortalConfig: Awaited<ReturnType<typeof loadToolPortalConfig>>;
	try {
		const configDir = resolveProjectCheckoutPath(options.systemConfig, zone.toolPortal.configDir);
		[mcpConfig, toolPortalConfig] = await Promise.all([
			loadMcpConfig(path.join(configDir, 'mcp.config.jsonc')),
			loadToolPortalConfig(path.join(configDir, 'tool-portal.config.jsonc')),
		]);
		servers = await resolveUpstreamServers({
			config: mcpConfig,
			resolveSecret: async (secret) => await resolveProviderSecret(secret, options.secretResolver),
		});
	} catch (error) {
		return zoneConfigFailure(zone.id, error);
	}
	const serverNamespaces = new Set(servers.map((server) => server.namespace));
	const referencedNamespaces = new Set<string>();
	let namespaceChecks: readonly ConfigValidationCheck[];
	try {
		namespaceChecks = Object.entries(toolPortalConfig.agents).flatMap(([agentId, agent]) => {
			const profile = requireToolPortalProfile(toolPortalConfig, agent.profile);
			return profileNamespaces(profile).flatMap((namespace) => {
				referencedNamespaces.add(namespace);
				if (serverNamespaces.has(namespace)) {
					return [];
				}
				return [
					{
						hint: `Tool Portal agent '${agentId}' profile '${agent.profile}' references MCP namespace '${namespace}', but no provider with that namespace exists in mcp.config.jsonc.`,
						name: `mcp-live-profile-namespace-${zone.id}-${agentId}-${namespace}`,
						ok: false,
					} satisfies ConfigValidationCheck,
				];
			});
		});
	} catch (error) {
		return zoneConfigFailure(zone.id, error);
	}

	const namespacesToValidate = [...serverNamespaces]
		.filter((namespace) => referencedNamespaces.has(namespace))
		.toSorted();
	const runtime = (options.createRuntime ?? createUpstreamMcpClientRuntime)({ servers });
	const agentScopeId = `validate:${zone.id}`;
	try {
		const namespaceCheckGroups = await Promise.all(
			namespacesToValidate.map(
				async (namespace) =>
					await validateMcpPortalNamespace({
						agentScopeId,
						namespace,
						runtime,
						toolPortalConfig,
						zoneId: zone.id,
					}),
			),
		);
		return [...namespaceChecks, ...namespaceCheckGroups.flat()];
	} finally {
		await runtime.closeAgentScope(agentScopeId);
	}
}

export async function runLiveMcpPortalValidation(
	options: RunLiveMcpPortalValidationOptions,
): Promise<readonly ConfigValidationCheck[]> {
	const checkGroups = await Promise.all(
		options.systemConfig.zones.map(async (zone) => await validateMcpPortalZone(options, zone)),
	);
	return checkGroups.flat();
}
