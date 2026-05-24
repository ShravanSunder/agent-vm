import path from 'node:path';

import {
	loadMcpConfig,
	loadMcpPortalConfig,
	type PortalToolSelector,
	resolveMcpPortalProfile,
	type ResolvedMcpPortalProfile,
	type SecretValue,
} from '@agent-vm/config-contracts';
import { createUpstreamMcpClientRuntime, UpstreamMcpError } from '@agent-vm/mcp-portal';
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

function profileNamespaces(profile: ResolvedMcpPortalProfile): readonly string[] {
	return Array.from(
		new Set([
			...profile.enabledNamespaces,
			...Object.keys(profile.enabledToolsByNamespace),
			...Object.keys(profile.hiddenToolsByNamespace),
			...Object.keys(profile.approval.callPoliciesByNamespace),
			...profile.approval.allowWithoutApprovalTools.map((tool) => tool.namespace),
			...profile.approval.alwaysAskTools.map((tool) => tool.namespace),
			...profile.approval.writeTools.map((tool) => tool.namespace),
		]),
	).toSorted();
}

function selectorToolNames(selector: PortalToolSelector): readonly string[] {
	return selector.allow === '*' ? selector.deny : [...selector.allow, ...selector.deny];
}

function profileToolNamesForNamespace(
	profile: ResolvedMcpPortalProfile,
	namespace: string,
): readonly string[] {
	const callPolicy = profile.approval.callPoliciesByNamespace[namespace];
	return Array.from(
		new Set([
			...(profile.enabledToolsByNamespace[namespace] ?? []),
			...(profile.hiddenToolsByNamespace[namespace] ?? []),
			...(callPolicy === undefined
				? []
				: [
						...selectorToolNames(callPolicy.requiresApproval),
						...selectorToolNames(callPolicy.withoutApproval),
					]),
			...profile.approval.allowWithoutApprovalTools
				.filter((tool) => tool.namespace === namespace)
				.map((tool) => tool.toolName),
			...profile.approval.alwaysAskTools
				.filter((tool) => tool.namespace === namespace)
				.map((tool) => tool.toolName),
			...profile.approval.writeTools
				.filter((tool) => tool.namespace === namespace)
				.map((tool) => tool.toolName),
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
	readonly portalConfig: Awaited<ReturnType<typeof loadMcpPortalConfig>>;
	readonly runtime: ReturnType<typeof createUpstreamMcpClientRuntime>;
	readonly zoneId: string;
}): Promise<readonly ConfigValidationCheck[]> {
	try {
		const tools = await props.runtime.listTools({
			agentScopeId: props.agentScopeId,
			namespace: props.namespace,
		});
		const actualToolNames = new Set(tools.map((tool) => tool.name));
		const actualToolNameList = tools.map((tool) => tool.name).toSorted();
		const profileToolChecks = Object.entries(props.portalConfig.agents).flatMap(
			([agentId, agent]) => {
				const profile = resolveMcpPortalProfile(props.portalConfig, agent.profile);
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
			},
			...profileToolChecks,
		];
	} catch (error) {
		return [
			{
				hint: validationHintForError(error),
				name: `mcp-live-${props.zoneId}-${props.namespace}`,
				ok: false,
			},
		];
	}
}

async function validateMcpPortalZone(
	options: RunLiveMcpPortalValidationOptions,
	zone: LoadedZoneConfig,
): Promise<readonly ConfigValidationCheck[]> {
	if (zone.gateway.type !== 'openclaw' || zone.mcpPortal === undefined) {
		return [];
	}
	let mcpConfig: Awaited<ReturnType<typeof loadMcpConfig>>;
	let portalConfig: Awaited<ReturnType<typeof loadMcpPortalConfig>>;
	let servers: Awaited<ReturnType<typeof resolveUpstreamServers>>;
	try {
		const configDir = resolveProjectCheckoutPath(options.systemConfig, zone.mcpPortal.configDir);
		[mcpConfig, portalConfig] = await Promise.all([
			loadMcpConfig(path.join(configDir, 'mcp.config.jsonc')),
			loadMcpPortalConfig(path.join(configDir, 'mcp-portal.config.jsonc')),
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
		namespaceChecks = Object.entries(portalConfig.agents).flatMap(([agentId, agent]) => {
			const profile = resolveMcpPortalProfile(portalConfig, agent.profile);
			return profileNamespaces(profile).flatMap((namespace) => {
				referencedNamespaces.add(namespace);
				if (serverNamespaces.has(namespace)) {
					return [];
				}
				return [
					{
						hint: `Agent '${agentId}' profile '${agent.profile}' references MCP namespace '${namespace}', but no provider with that namespace exists in mcp.config.jsonc.`,
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
						portalConfig,
						runtime,
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
