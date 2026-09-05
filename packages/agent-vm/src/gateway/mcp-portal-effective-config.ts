import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import {
	loadMcpConfig,
	loadToolPortalConfig,
	compileToolPortalNamespaceDiscoveryByProfile,
	effectiveManagedToolPortalConfigSchema,
	encodeConfiguredCliPreparedImageIdentity,
	managedToolPortalConfigSchema,
	mcpPortalConfigSchema,
	preparedManagedToolPortalConfigSchema,
	toolPortalNamespaceAllowsOperation,
	type FormattedSecretValue,
	type EffectiveManagedToolPortalConfig,
	type McpConfig,
	type McpPortalConfig,
	type PreparedManagedToolPortalConfig,
	type ToolPortalNamespacePolicy,
	type ToolPortalConfig,
} from '@agent-vm/config-contracts';
import type { ManagedVmImageCapability } from '@agent-vm/managed-vm';
import type { MediatedSecretSpec, SecretRef, SecretResolver } from '@agent-vm/secret-management';

import {
	compileCredentialedRuntimeConfig,
	type ControllerCredentialedRuntimeRegistrySnapshot,
} from '../controller/credentialed-runtime/credentialed-runtime-registry.js';

export interface McpPortalEffectiveConfigProps {
	readonly approvalAccessConfigured: boolean;
	readonly allowedRawEnvSecretNames?: readonly string[];
	readonly authoredConfigDir: string;
	readonly declaredAgentIds?: readonly string[];
	readonly effectiveHostConfigDir: string;
	readonly managedVmImages?: ManagedVmImageCapability;
	readonly sharedImageCacheDir?: string;
	readonly secretResolver: SecretResolver;
	readonly workspaceGitPushAgentEligibility?: WorkspaceGitPushAgentEligibility;
	readonly zoneId: string;
}

export interface McpPortalEffectiveConfigFromConfigProps {
	readonly approvalAccessConfigured: boolean;
	readonly allowedRawEnvSecretNames?: readonly string[];
	readonly authoredConfigDir?: string;
	readonly declaredAgentIds?: readonly string[];
	readonly effectiveHostConfigDir: string;
	readonly mcpConfig: McpConfig;
	readonly managedVmImages?: ManagedVmImageCapability;
	readonly sharedImageCacheDir?: string;
	readonly secretResolver: SecretResolver;
	readonly toolPortalConfig: ToolPortalConfig;
	readonly workspaceGitPushAgentEligibility?: WorkspaceGitPushAgentEligibility;
	readonly zoneId: string;
}

export interface WorkspaceGitPushAgentEligibility {
	readonly eligibleAgentIds: readonly string[];
}

export interface McpPortalEffectiveConfigPlan<
	TToolPortalConfig extends EffectiveManagedToolPortalConfig | ToolPortalConfig =
		EffectiveManagedToolPortalConfig,
> {
	readonly effectiveConfigDir: string;
	readonly effectiveMcpConfig: McpConfig;
	readonly effectivePortalConfig: McpPortalConfig;
	readonly effectiveToolPortalConfig: TToolPortalConfig;
	readonly requiredGatewayEgressHosts: readonly string[];
	readonly resolvedSecretNames: readonly string[];
	readonly runtimeEnvironment: Readonly<Record<string, string>>;
	readonly runtimeMediatedSecrets: Readonly<Record<string, MediatedSecretSpec>>;
}

export type McpPortalEffectiveConfigWriteResult =
	McpPortalEffectiveConfigPlan<EffectiveManagedToolPortalConfig> & {
		readonly credentialedRuntimeRegistrySnapshot: ControllerCredentialedRuntimeRegistrySnapshot;
	};

const effectiveConfigManifestFileName = 'tool-portal-effective-manifest.json';
const managedControllerExecutionToolsByNamespace: Readonly<Record<string, ReadonlySet<string>>> =
	Object.freeze({
		controller_execution: new Set(['controller_host_probe', 'workspace_git_push']),
		oauth_authorization: new Set(['begin', 'cancel', 'list', 'reauthorize', 'revoke', 'status']),
	});

interface EffectiveConfigManifest {
	readonly mcpConfigFile: string;
	readonly portalConfigFile: string;
	readonly schemaVersion: 1;
	readonly toolPortalConfigFile: string;
}

function recordEntries<TValue>(
	record: Readonly<Record<string, TValue>>,
): readonly (readonly [string, TValue])[] {
	return Object.entries(record);
}

type EffectivePortalSourceProfile =
	| EffectiveManagedToolPortalConfig['profiles'][string]
	| PreparedManagedToolPortalConfig['profiles'][string]
	| ToolPortalConfig['profiles'][string];
type EffectivePortalSourceNamespacePolicy = EffectivePortalSourceProfile['namespaces'][string];

export interface McpPortalEffectiveToolPortalConfigSnapshot {
	readonly effectiveMcpConfig: McpConfig;
	readonly effectiveToolPortalConfig: EffectiveManagedToolPortalConfig;
	readonly toolPortalConfigPath: string;
}

async function prepareConfiguredCliManagedVmImages(props: {
	readonly authoredConfigDir: string | undefined;
	readonly effectiveHostConfigDir: string;
	readonly managedVmImages: ManagedVmImageCapability | undefined;
	readonly mcpConfig: McpConfig;
	readonly sharedImageCacheDir: string | undefined;
	readonly toolPortalConfig: ToolPortalConfig;
}): Promise<PreparedManagedToolPortalConfig> {
	const effectiveConfig = structuredClone(props.toolPortalConfig);
	if (effectiveConfig.mode !== 'managed') {
		throw new Error('tool-portal: effective Managed VM image preparation requires managed mode.');
	}
	for (const profile of Object.values(effectiveConfig.profiles)) {
		for (const [namespaceId, namespacePolicy] of Object.entries(profile.namespaces)) {
			if (namespacePolicy.backend.kind !== 'controller_execution') continue;
			namespacePolicy.backend.operations = Object.fromEntries(
				Object.entries(namespacePolicy.backend.operations).filter(([operationName]) =>
					toolPortalNamespaceAllowsOperation(namespacePolicy, operationName),
				),
			);
			if (Object.keys(namespacePolicy.backend.operations).length === 0) {
				delete profile.namespaces[namespaceId];
			}
		}
	}
	const ephemeralTargets = Object.values(effectiveConfig.profiles).flatMap((profile) =>
		Object.values(profile.namespaces).flatMap((namespacePolicy) =>
			namespacePolicy.backend.kind !== 'controller_execution'
				? []
				: Object.values(namespacePolicy.backend.operations).flatMap((operation) =>
						operation.kind === 'configured_cli' &&
						operation.executionTarget.kind === 'ephemeral_managed_vm'
							? [operation.executionTarget]
							: [],
					),
		),
	);
	const namespaceDiscoveryByProfile = compileToolPortalNamespaceDiscoveryByProfile({
		mcpConfig: props.mcpConfig,
		toolPortalConfig: props.toolPortalConfig,
	});
	const authoredConfigDir = props.authoredConfigDir;
	const managedVmImages = props.managedVmImages;
	if (
		ephemeralTargets.length > 0 &&
		(authoredConfigDir === undefined ||
			managedVmImages === undefined ||
			props.sharedImageCacheDir === undefined)
	) {
		throw new Error(
			'tool-portal: ephemeral managed VM operations require the existing Managed VM image preparation capability.',
		);
	}
	const preparedImagesByRecipePath = new Map<
		string,
		Promise<{ readonly fingerprint: string; readonly imageReference: string }>
	>();
	await Promise.all(
		ephemeralTargets.map(async (target): Promise<void> => {
			if (authoredConfigDir === undefined || managedVmImages === undefined) {
				throw new Error('Tool Portal Managed VM image preparation is unavailable.');
			}
			const recipePath = path.resolve(authoredConfigDir, target.imageReference);
			let preparedImage = preparedImagesByRecipePath.get(recipePath);
			if (preparedImage === undefined) {
				if (props.sharedImageCacheDir === undefined) {
					throw new Error('Tool Portal shared Managed VM image cache is unavailable.');
				}
				preparedImage = managedVmImages.prepareImage({
					artifactCacheDirectory: props.sharedImageCacheDir,
					recipePath,
				});
				preparedImagesByRecipePath.set(recipePath, preparedImage);
			}
			const prepared = await preparedImage;
			target.imageReference = encodeConfiguredCliPreparedImageIdentity({
				fingerprint: prepared.fingerprint,
				imageReference: prepared.imageReference,
				schemaVersion: 1,
			});
		}),
	);
	return preparedManagedToolPortalConfigSchema.parse({
		...effectiveConfig,
		profiles: Object.fromEntries(
			Object.entries(effectiveConfig.profiles).map(([profileId, profile]) => {
				const discoveryByNamespace = new Map(
					(namespaceDiscoveryByProfile[profileId] ?? []).map((entry) => [
						entry.namespace,
						entry.summary === undefined ? {} : { summary: entry.summary },
					]),
				);
				return [
					profileId,
					{
						namespaces: Object.fromEntries(
							Object.entries(profile.namespaces).map(([namespace, namespacePolicy]) => [
								namespace,
								{
									...namespacePolicy,
									discovery: discoveryByNamespace.get(namespace) ?? {},
								},
							]),
						),
					},
				] as const;
			}),
		),
	});
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readEffectiveConfigManifestStringField(
	manifest: Readonly<Record<string, unknown>>,
	fieldName: keyof EffectiveConfigManifest,
): string {
	const value = manifest[fieldName];
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`mcp-portal: effective config manifest has invalid ${fieldName}.`);
	}
	return value;
}

async function readEffectiveConfigManifest(
	directoryPath: string,
): Promise<EffectiveConfigManifest> {
	const manifest: unknown = JSON.parse(
		await readFile(path.join(directoryPath, effectiveConfigManifestFileName), 'utf8'),
	);
	if (!isRecord(manifest) || manifest.schemaVersion !== 1) {
		throw new Error('mcp-portal: effective config manifest is malformed.');
	}
	return {
		mcpConfigFile: readEffectiveConfigManifestStringField(manifest, 'mcpConfigFile'),
		portalConfigFile: readEffectiveConfigManifestStringField(manifest, 'portalConfigFile'),
		schemaVersion: 1,
		toolPortalConfigFile: readEffectiveConfigManifestStringField(manifest, 'toolPortalConfigFile'),
	};
}

function resolveEffectiveConfigManifestFilePath(
	directoryPath: string,
	fileName: string,
	fieldName: keyof EffectiveConfigManifest,
): string {
	const resolvedDirectoryPath = path.resolve(directoryPath);
	const resolvedFilePath = path.resolve(resolvedDirectoryPath, fileName);
	if (path.dirname(resolvedFilePath) !== resolvedDirectoryPath) {
		throw new Error(
			`mcp-portal: effective config manifest ${fieldName} must stay inside the effective config directory.`,
		);
	}
	return resolvedFilePath;
}

function normalizeEnvironmentSegment(value: string): string {
	return value.replaceAll(/[^A-Za-z0-9_]/gu, '_').toUpperCase();
}

function envNameForProviderSecret(providerName: string, secretName: string): string {
	return `AGENT_VM_MCP_${normalizeEnvironmentSegment(providerName)}_${normalizeEnvironmentSegment(secretName)}`;
}

function assertValidHost(host: string, context: string): void {
	if (
		host.length === 0 ||
		host.includes('*') ||
		host.includes('/') ||
		host.includes(':') ||
		!host.includes('.')
	) {
		throw new Error(`mcp-portal: invalid ${context} host "${host}".`);
	}
}

function isLoopbackUrlHost(hostname: string): boolean {
	return (
		hostname === 'localhost' ||
		hostname === '127.0.0.1' ||
		hostname === '[::1]' ||
		hostname === '::1'
	);
}

function addRequiredHost(hosts: Set<string>, host: string, context: string): void {
	assertValidHost(host, context);
	hosts.add(host);
}

function addUrlHost(hosts: Set<string>, url: string, context: string): void {
	const parsedUrl = new URL(url);
	if (isLoopbackUrlHost(parsedUrl.hostname)) {
		return;
	}
	addRequiredHost(hosts, parsedUrl.hostname, context);
}

function providerSecrets(
	provider: McpConfig['providers'][string],
): Readonly<Record<string, FormattedSecretValue>> {
	return provider.transport.kind === 'stdio' ? provider.transport.env : provider.transport.headers;
}

function buildManagedEffectivePortalConfig(
	toolPortalConfig: EffectiveManagedToolPortalConfig | ToolPortalConfig,
): McpPortalConfig {
	return mcpPortalConfigSchema.parse({
		agents: Object.fromEntries(
			Object.entries(toolPortalConfig.agents).map(([agentId, agent]) => [
				agentId,
				{ profile: agent.profile },
			]),
		),
		profiles: Object.fromEntries(
			recordEntries<EffectivePortalSourceProfile>(toolPortalConfig.profiles).map(
				([profileId, profile]) => [
					profileId,
					{
						namespaces: Object.fromEntries(
							recordEntries<EffectivePortalSourceNamespacePolicy>(profile.namespaces).map(
								([namespaceId, namespacePolicy]) => [
									namespaceId,
									{
										calls: namespacePolicy.calls,
										tools: namespacePolicy.tools,
									},
								],
							),
						),
					},
				],
			),
		),
		schemaVersion: 1,
	});
}

function assertToolPortalAgentsMatchDeclaredAgents(props: {
	readonly declaredAgentIds?: readonly string[];
	readonly toolPortalConfig: ToolPortalConfig;
	readonly zoneId: string;
}): void {
	if (props.declaredAgentIds === undefined) {
		return;
	}
	const declaredAgentIds = new Set(props.declaredAgentIds);
	for (const agentId of declaredAgentIds) {
		if (props.toolPortalConfig.agents[agentId] !== undefined) {
			continue;
		}
		throw new Error(
			`tool-portal: zone "${props.zoneId}" declared agent "${agentId}" is missing from tool-portal.config.jsonc agents.`,
		);
	}
	for (const agentId of Object.keys(props.toolPortalConfig.agents)) {
		if (declaredAgentIds.has(agentId)) {
			continue;
		}
		throw new Error(
			`tool-portal: zone "${props.zoneId}" tool-portal.config.jsonc declares undeclared agent "${agentId}".`,
		);
	}
}

function assertManagedControllerExecutionPolicy(props: {
	readonly namespaceId: string;
	readonly namespacePolicy: ToolPortalNamespacePolicy;
	readonly profileId: string;
}): void {
	const registeredToolsForNamespace = managedControllerExecutionToolsByNamespace[props.namespaceId];
	if (
		registeredToolsForNamespace === undefined &&
		props.namespacePolicy.backend.kind === 'controller_execution' &&
		Object.values(props.namespacePolicy.backend.operations).some(
			(operation) => operation.kind === 'registered_action',
		)
	) {
		throw new Error(
			`tool-portal: managed profile "${props.profileId}" namespace "${props.namespaceId}" cannot remap definition-owned registered controller execution actions.`,
		);
	}
	if (props.namespacePolicy.tools.allow === '*') {
		throw new Error(
			`tool-portal: managed profile "${props.profileId}" namespace "${props.namespaceId}" tools must explicitly allow controller execution operations.`,
		);
	}
	if (
		props.namespacePolicy.calls.requiresApproval.allow === '*' ||
		props.namespacePolicy.calls.withoutApproval.allow === '*'
	) {
		throw new Error(
			`tool-portal: managed profile "${props.profileId}" namespace "${props.namespaceId}" calls must explicitly allow controller execution operations.`,
		);
	}
	const allowedTools = new Set(props.namespacePolicy.tools.allow);
	const allowedCalls = new Set([
		...props.namespacePolicy.calls.requiresApproval.allow,
		...props.namespacePolicy.calls.withoutApproval.allow,
	]);
	for (const toolName of [...allowedTools, ...allowedCalls]) {
		const operation =
			props.namespacePolicy.backend.kind === 'controller_execution'
				? props.namespacePolicy.backend.operations[toolName]
				: undefined;
		if (
			operation?.kind === 'registered_action' &&
			(registeredToolsForNamespace === undefined || !registeredToolsForNamespace.has(toolName))
		) {
			throw new Error(
				`tool-portal: managed profile "${props.profileId}" namespace "${props.namespaceId}" references an unknown registered controller execution action.`,
			);
		}
		if (!allowedTools.has(toolName) || !allowedCalls.has(toolName)) {
			throw new Error(
				`tool-portal: managed profile "${props.profileId}" namespace "${props.namespaceId}" must include each controller execution operation in tools and exactly one call selector.`,
			);
		}
	}
}

function tokensAreEqualOrProperPrefixes(
	leftTokens: readonly string[],
	rightTokens: readonly string[],
): boolean {
	const sharedLength = Math.min(leftTokens.length, rightTokens.length);
	return (
		leftTokens.slice(0, sharedLength).every((token, index) => token === rightTokens[index]) &&
		(leftTokens.length === sharedLength || rightTokens.length === sharedLength)
	);
}

function assertEffectiveConfiguredCliCommandsDoNotOverlap(props: {
	readonly profile: ToolPortalConfig['profiles'][string];
	readonly profileId: string;
}): void {
	const commandsByExecutable = new Map<
		string,
		{ readonly identity: string; readonly tokens: readonly string[] }[]
	>();
	for (const [namespaceId, namespacePolicy] of Object.entries(props.profile.namespaces)) {
		if (namespacePolicy.backend.kind !== 'controller_execution') continue;
		for (const [operationName, operation] of Object.entries(namespacePolicy.backend.operations)) {
			if (operation.kind !== 'configured_cli') continue;
			const commands = commandsByExecutable.get(operation.executablePath) ?? [];
			for (const command of operation.commands) {
				commands.push({
					identity: `${namespaceId}.${operationName}`,
					tokens: [...operation.mandatoryArgvPrefix, ...command.path],
				});
			}
			commandsByExecutable.set(operation.executablePath, commands);
		}
	}
	for (const [executablePath, commands] of commandsByExecutable) {
		for (const [leftIndex, leftCommand] of commands.entries()) {
			for (const rightCommand of commands.slice(leftIndex + 1)) {
				if (!tokensAreEqualOrProperPrefixes(leftCommand.tokens, rightCommand.tokens)) continue;
				throw new Error(
					`tool-portal: managed profile "${props.profileId}" has overlapping effective configured CLI commands for executable "${executablePath}" between "${leftCommand.identity}" and "${rightCommand.identity}".`,
				);
			}
		}
	}
}

function selectorAllowsTool(
	selector: ToolPortalNamespacePolicy['tools'],
	toolName: string,
): boolean {
	return (
		!selector.deny.includes(toolName) &&
		(selector.allow === '*' || selector.allow.includes(toolName))
	);
}

function profileAllowsWorkspaceGitPush(profile: ToolPortalConfig['profiles'][string]): boolean {
	return Object.values(profile.namespaces).some(
		(namespacePolicy) =>
			namespacePolicy.backend.kind === 'controller_execution' &&
			selectorAllowsTool(namespacePolicy.tools, 'workspace_git_push') &&
			(selectorAllowsTool(namespacePolicy.calls.requiresApproval, 'workspace_git_push') ||
				selectorAllowsTool(namespacePolicy.calls.withoutApproval, 'workspace_git_push')),
	);
}

function assertWorkspaceGitPushAgentEligibility(props: {
	readonly eligibility: WorkspaceGitPushAgentEligibility | undefined;
	readonly toolPortalConfig: ToolPortalConfig;
}): void {
	const eligibleAgentIds = new Set<string>();
	for (const agentId of props.eligibility?.eligibleAgentIds ?? []) {
		if (eligibleAgentIds.has(agentId)) {
			throw new Error(
				`tool-portal: workspace Git push eligibility contains duplicate agent "${agentId}".`,
			);
		}
		if (props.toolPortalConfig.agents[agentId] === undefined) {
			throw new Error(
				`tool-portal: workspace Git push eligibility contains unassigned agent "${agentId}".`,
			);
		}
		eligibleAgentIds.add(agentId);
	}

	for (const [agentId, assignment] of Object.entries(props.toolPortalConfig.agents)) {
		const profile = props.toolPortalConfig.profiles[assignment.profile];
		if (profile === undefined || !profileAllowsWorkspaceGitPush(profile)) {
			continue;
		}
		if (eligibleAgentIds.has(agentId)) {
			continue;
		}
		throw new Error(
			`tool-portal: managed agent "${agentId}" assigned profile "${assignment.profile}" cannot allow workspace_git_push because trusted workspace Git mode is not remote.`,
		);
	}
}

function assertManagedToolPortalConfig(props: {
	readonly approvalAccessConfigured: boolean;
	readonly toolPortalConfig: ToolPortalConfig;
	readonly workspaceGitPushAgentEligibility: WorkspaceGitPushAgentEligibility | undefined;
}): void {
	if (
		!props.approvalAccessConfigured &&
		managedToolPortalRequiresApprovalAccess(props.toolPortalConfig)
	) {
		throw new Error(
			'tool-portal: managed calls requiring approval require zones[].approvalAccess with at least one authenticated approver.',
		);
	}
	for (const [profileId, profile] of Object.entries(props.toolPortalConfig.profiles)) {
		for (const [namespaceId, namespacePolicy] of Object.entries(profile.namespaces)) {
			if (namespacePolicy.backend.kind !== 'controller_execution') {
				continue;
			}
			assertManagedControllerExecutionPolicy({
				namespaceId,
				namespacePolicy,
				profileId,
			});
		}
		assertEffectiveConfiguredCliCommandsDoNotOverlap({ profile, profileId });
	}
	assertWorkspaceGitPushAgentEligibility({
		eligibility: props.workspaceGitPushAgentEligibility,
		toolPortalConfig: props.toolPortalConfig,
	});
}

function selectorEffectivelyAllowsAnyTool(
	selector: ToolPortalNamespacePolicy['calls']['requiresApproval'],
): boolean {
	return (
		selector.allow === '*' || selector.allow.some((toolName) => !selector.deny.includes(toolName))
	);
}

export function managedToolPortalRequiresApprovalAccess(config: ToolPortalConfig): boolean {
	return Object.values(config.profiles).some((profile) =>
		Object.values(profile.namespaces).some((namespacePolicy) => {
			if (selectorEffectivelyAllowsAnyTool(namespacePolicy.calls.requiresApproval)) return true;
			if (namespacePolicy.backend.kind !== 'controller_execution') return false;
			return Object.entries(namespacePolicy.backend.operations).some(
				([operationName, operation]) =>
					operation.kind === 'configured_cli' &&
					operation.calls.requiresApproval.length > 0 &&
					selectorAllowsTool(namespacePolicy.tools, operationName) &&
					selectorAllowsTool(namespacePolicy.calls.withoutApproval, operationName),
			);
		}),
	);
}

function providerSecretRef(secret: FormattedSecretValue): SecretRef {
	if (secret.source === 'environment') {
		return { ref: secret.name, source: 'environment' };
	}
	return { ref: secret.ref, source: '1password' };
}

function generatedEnvironmentSecretForProviderSecret(
	secret: FormattedSecretValue,
	envName: string,
): FormattedSecretValue {
	const generatedSecret = { name: envName, source: 'environment' } as const;
	if (secret.format === undefined) {
		return generatedSecret;
	}
	return { ...generatedSecret, format: secret.format };
}

function assertAllowedRawEnvSecret(
	envName: string,
	allowedRawEnvSecretNames: ReadonlySet<string>,
): void {
	if (allowedRawEnvSecretNames.has(envName)) {
		return;
	}
	throw new Error(
		`mcp-portal: provider secret '${envName}' uses env injection but is not listed in gateway.rawEnvSecrets. Use http-mediation or add an explicit raw-env exception.`,
	);
}

function validateProviderNetwork(
	providerName: string,
	provider: McpConfig['providers'][string],
	requiredGatewayEgressHosts: Set<string>,
): void {
	const transport = provider.transport;
	if (transport.kind === 'stdio') {
		if (transport.networkAccess === undefined) {
			throw new Error(
				`mcp-portal: stdio provider "${provider.namespace || providerName}" must declare networkAccess.`,
			);
		}
		if (transport.networkAccess === 'declared' && transport.requiredEgressHosts.length === 0) {
			throw new Error(
				`mcp-portal: stdio provider "${provider.namespace || providerName}" declares network access but no requiredEgressHosts.`,
			);
		}
		if (transport.networkAccess === 'none' && transport.requiredEgressHosts.length > 0) {
			throw new Error(
				`mcp-portal: stdio provider "${provider.namespace || providerName}" declares networkAccess none but has requiredEgressHosts.`,
			);
		}
		for (const host of transport.requiredEgressHosts) {
			addRequiredHost(requiredGatewayEgressHosts, host, `provider ${provider.namespace}`);
		}
		return;
	}

	addUrlHost(requiredGatewayEgressHosts, transport.url, `provider ${provider.namespace}`);
	for (const host of transport.requiredEgressHosts) {
		addRequiredHost(requiredGatewayEgressHosts, host, `provider ${provider.namespace}`);
	}
}

async function buildEffectivePlanFromConfig(
	props: McpPortalEffectiveConfigFromConfigProps,
	resolveSecrets: false,
): Promise<McpPortalEffectiveConfigPlan<ToolPortalConfig>>;
async function buildEffectivePlanFromConfig(
	props: McpPortalEffectiveConfigFromConfigProps,
	resolveSecrets: true,
): Promise<McpPortalEffectiveConfigWriteResult>;
async function buildEffectivePlanFromConfig(
	props: McpPortalEffectiveConfigFromConfigProps,
	resolveSecrets: boolean,
): Promise<McpPortalEffectiveConfigWriteResult | McpPortalEffectiveConfigPlan<ToolPortalConfig>> {
	assertToolPortalAgentsMatchDeclaredAgents({
		...(props.declaredAgentIds === undefined ? {} : { declaredAgentIds: props.declaredAgentIds }),
		toolPortalConfig: props.toolPortalConfig,
		zoneId: props.zoneId,
	});
	assertManagedToolPortalConfig({
		approvalAccessConfigured: props.approvalAccessConfigured,
		toolPortalConfig: props.toolPortalConfig,
		workspaceGitPushAgentEligibility: props.workspaceGitPushAgentEligibility,
	});
	compileToolPortalNamespaceDiscoveryByProfile({
		mcpConfig: props.mcpConfig,
		toolPortalConfig: props.toolPortalConfig,
	});
	const requiredGatewayEgressHosts = new Set<string>();
	const allowedRawEnvSecretNames = new Set(props.allowedRawEnvSecretNames ?? []);
	const secretRefs: Record<string, SecretRef> = {};
	const secretSourcesByEnvName = new Map<
		string,
		{ readonly providerName: string; readonly secretName: string }
	>();
	const secretPoliciesByEnvName = new Map<
		string,
		{ readonly hosts: readonly string[]; readonly injection: 'env' | 'http-mediation' }
	>();
	const effectiveProviders: McpConfig['providers'] = {};

	for (const [providerName, provider] of Object.entries(props.mcpConfig.providers)) {
		validateProviderNetwork(providerName, provider, requiredGatewayEgressHosts);
		const effectiveProvider = structuredClone(provider);
		const transportSecrets =
			effectiveProvider.transport.kind === 'stdio'
				? effectiveProvider.transport.env
				: effectiveProvider.transport.headers;
		const providerNamespace = provider.namespace || providerName;
		for (const [secretName, secret] of Object.entries(providerSecrets(provider))) {
			const policy = provider.secretPolicies[secretName];
			if (policy === undefined) {
				throw new Error(
					`mcp-portal: provider "${provider.namespace}" secret "${secretName}" requires secretPolicies.${secretName}.`,
				);
			}
			if (policy.injection === 'http-mediation' && policy.hosts.length === 0) {
				throw new Error(
					`mcp-portal: provider "${provider.namespace}" secret "${secretName}" uses http-mediation without hosts.`,
				);
			}
			for (const host of policy.hosts) {
				addRequiredHost(requiredGatewayEgressHosts, host, `secret policy ${secretName}`);
			}
			const envName = envNameForProviderSecret(providerNamespace, secretName);
			if (policy.injection === 'env') {
				assertAllowedRawEnvSecret(envName, allowedRawEnvSecretNames);
			}
			const existingSource = secretSourcesByEnvName.get(envName);
			if (existingSource !== undefined) {
				throw new Error(
					`mcp-portal: generated secret environment name collision for ${envName} between ` +
						`${existingSource.providerName}.${existingSource.secretName} and ` +
						`${providerNamespace}.${secretName}.`,
				);
			}
			secretSourcesByEnvName.set(envName, { providerName: providerNamespace, secretName });
			secretRefs[envName] = providerSecretRef(secret);
			secretPoliciesByEnvName.set(envName, policy);
			transportSecrets[secretName] = generatedEnvironmentSecretForProviderSecret(secret, envName);
		}
		effectiveProviders[providerName] = effectiveProvider;
	}

	const resolvedSecrets = resolveSecrets ? await props.secretResolver.resolveAll(secretRefs) : {};
	const runtimeEnvironment: Record<string, string> = {};
	const runtimeMediatedSecrets: Record<string, MediatedSecretSpec> = {};
	if (resolveSecrets) {
		for (const [envName, policy] of secretPoliciesByEnvName.entries()) {
			const value = resolvedSecrets[envName];
			if (value === undefined || value.length === 0) {
				throw new Error(`mcp-portal: secret resolver returned no value for ${envName}.`);
			}
			if (policy.injection === 'env') {
				runtimeEnvironment[envName] = value;
			} else {
				runtimeMediatedSecrets[envName] = { hosts: [...policy.hosts], value };
			}
		}
	}

	const commonResult = {
		effectiveConfigDir: props.effectiveHostConfigDir,
		effectiveMcpConfig: { ...props.mcpConfig, providers: effectiveProviders },
		requiredGatewayEgressHosts: [...requiredGatewayEgressHosts].toSorted(),
		resolvedSecretNames: Object.keys(secretRefs).toSorted(),
		runtimeEnvironment,
		runtimeMediatedSecrets,
	};
	if (!resolveSecrets) {
		const effectiveToolPortalConfig = managedToolPortalConfigSchema.parse(
			structuredClone(props.toolPortalConfig),
		);
		return {
			...commonResult,
			effectivePortalConfig: buildManagedEffectivePortalConfig(effectiveToolPortalConfig),
			effectiveToolPortalConfig,
		};
	}
	const preparedToolPortalConfig = await prepareConfiguredCliManagedVmImages({
		authoredConfigDir: props.authoredConfigDir,
		effectiveHostConfigDir: props.effectiveHostConfigDir,
		managedVmImages: props.managedVmImages,
		mcpConfig: props.mcpConfig,
		sharedImageCacheDir: props.sharedImageCacheDir,
		toolPortalConfig: props.toolPortalConfig,
	});
	const compiledCredentialedRuntimeConfig = compileCredentialedRuntimeConfig({
		preparedConfig: preparedToolPortalConfig,
		zoneId: props.zoneId,
	});
	return {
		...commonResult,
		credentialedRuntimeRegistrySnapshot: compiledCredentialedRuntimeConfig.registrySnapshot,
		effectivePortalConfig: buildManagedEffectivePortalConfig(
			compiledCredentialedRuntimeConfig.effectiveToolPortalConfig,
		),
		effectiveToolPortalConfig: compiledCredentialedRuntimeConfig.effectiveToolPortalConfig,
	};
}

async function buildEffectivePlan(
	props: McpPortalEffectiveConfigProps,
	resolveSecrets: false,
): Promise<McpPortalEffectiveConfigPlan<ToolPortalConfig>>;
async function buildEffectivePlan(
	props: McpPortalEffectiveConfigProps,
	resolveSecrets: true,
): Promise<McpPortalEffectiveConfigWriteResult>;
async function buildEffectivePlan(
	props: McpPortalEffectiveConfigProps,
	resolveSecrets: boolean,
): Promise<McpPortalEffectiveConfigWriteResult | McpPortalEffectiveConfigPlan<ToolPortalConfig>> {
	const [mcpConfig, toolPortalConfig] = await Promise.all([
		loadMcpConfig(path.join(props.authoredConfigDir, 'mcp.config.jsonc')),
		loadToolPortalConfig(path.join(props.authoredConfigDir, 'tool-portal.config.jsonc')),
	]);
	const configProps: McpPortalEffectiveConfigFromConfigProps = {
		approvalAccessConfigured: props.approvalAccessConfigured,
		authoredConfigDir: props.authoredConfigDir,
		effectiveHostConfigDir: props.effectiveHostConfigDir,
		...(props.managedVmImages === undefined ? {} : { managedVmImages: props.managedVmImages }),
		mcpConfig,
		secretResolver: props.secretResolver,
		toolPortalConfig,
		zoneId: props.zoneId,
		...(props.allowedRawEnvSecretNames === undefined
			? {}
			: { allowedRawEnvSecretNames: props.allowedRawEnvSecretNames }),
		...(props.declaredAgentIds === undefined ? {} : { declaredAgentIds: props.declaredAgentIds }),
		...(props.workspaceGitPushAgentEligibility === undefined
			? {}
			: { workspaceGitPushAgentEligibility: props.workspaceGitPushAgentEligibility }),
	};
	return resolveSecrets
		? await buildEffectivePlanFromConfig(configProps, true)
		: await buildEffectivePlanFromConfig(configProps, false);
}

async function writeNewFileAndSync(filePath: string, content: string): Promise<void> {
	const handle = await open(filePath, 'wx', 0o600);
	try {
		await handle.writeFile(content, 'utf8');
		await handle.sync();
		await handle.close();
	} catch (error) {
		await handle.close().catch(() => undefined);
		await rm(filePath, { force: true });
		throw error;
	}
}

async function replaceFileAtomically(filePath: string, content: string): Promise<void> {
	const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	await writeNewFileAndSync(tempPath, content);
	try {
		await rename(tempPath, filePath);
	} catch (error) {
		await rm(tempPath, { force: true });
		throw error;
	}
}

async function syncDirectory(directoryPath: string): Promise<void> {
	const handle = await open(directoryPath, 'r');
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function isGeneratedEffectiveConfigFileName(fileName: string): boolean {
	return (
		/^mcp\.config\.[0-9a-f-]+\.jsonc$/u.test(fileName) ||
		/^mcp-portal\.config\.[0-9a-f-]+\.jsonc$/u.test(fileName) ||
		/^tool-portal\.config\.[0-9a-f-]+\.jsonc$/u.test(fileName)
	);
}

async function pruneStaleGeneratedConfigFiles(
	directoryPath: string,
	currentFileNames: ReadonlySet<string>,
): Promise<void> {
	const entries = await readdir(directoryPath, { withFileTypes: true });
	await Promise.all(
		entries
			.filter(
				(entry) =>
					entry.isFile() &&
					isGeneratedEffectiveConfigFileName(entry.name) &&
					!currentFileNames.has(entry.name),
			)
			.map((entry) => rm(path.join(directoryPath, entry.name), { force: true })),
	);
}

async function writeEffectiveConfigGeneration(props: {
	readonly directoryPath: string;
	readonly mcpConfigContent: string;
	readonly portalConfigContent: string;
	readonly toolPortalConfigContent: string;
}): Promise<void> {
	const generation = randomUUID();
	const manifest: EffectiveConfigManifest = {
		mcpConfigFile: `mcp.config.${generation}.jsonc`,
		portalConfigFile: `mcp-portal.config.${generation}.jsonc`,
		schemaVersion: 1,
		toolPortalConfigFile: `tool-portal.config.${generation}.jsonc`,
	};
	const currentFileNames = new Set([
		manifest.mcpConfigFile,
		manifest.portalConfigFile,
		manifest.toolPortalConfigFile,
	]);

	await writeNewFileAndSync(
		path.join(props.directoryPath, manifest.mcpConfigFile),
		props.mcpConfigContent,
	);
	await writeNewFileAndSync(
		path.join(props.directoryPath, manifest.portalConfigFile),
		props.portalConfigContent,
	);
	await writeNewFileAndSync(
		path.join(props.directoryPath, manifest.toolPortalConfigFile),
		props.toolPortalConfigContent,
	);
	await replaceFileAtomically(
		path.join(props.directoryPath, effectiveConfigManifestFileName),
		`${JSON.stringify(manifest, null, '\t')}\n`,
	);
	await syncDirectory(props.directoryPath);
	await pruneStaleGeneratedConfigFiles(props.directoryPath, currentFileNames);
}

export async function planMcpPortalEffectiveConfig(
	props: McpPortalEffectiveConfigProps,
): Promise<McpPortalEffectiveConfigPlan<ToolPortalConfig>> {
	return await buildEffectivePlan(props, false);
}

export async function loadMcpPortalEffectiveToolPortalConfigSnapshot(
	effectiveHostConfigDir: string,
): Promise<McpPortalEffectiveToolPortalConfigSnapshot> {
	const manifest = await readEffectiveConfigManifest(effectiveHostConfigDir);
	const mcpConfigPath = resolveEffectiveConfigManifestFilePath(
		effectiveHostConfigDir,
		manifest.mcpConfigFile,
		'mcpConfigFile',
	);
	const toolPortalConfigPath = resolveEffectiveConfigManifestFilePath(
		effectiveHostConfigDir,
		manifest.toolPortalConfigFile,
		'toolPortalConfigFile',
	);
	const effectiveToolPortalConfig = effectiveManagedToolPortalConfigSchema.parse(
		JSON.parse(await readFile(toolPortalConfigPath, 'utf8')),
	);
	const effectiveMcpConfig = await loadMcpConfig(mcpConfigPath);
	return { effectiveMcpConfig, effectiveToolPortalConfig, toolPortalConfigPath };
}

export async function planMcpPortalEffectiveConfigFromConfig(
	props: McpPortalEffectiveConfigFromConfigProps,
): Promise<McpPortalEffectiveConfigPlan<ToolPortalConfig>> {
	return await buildEffectivePlanFromConfig(props, false);
}

export async function resolveMcpPortalEffectiveConfigFromConfig(
	props: McpPortalEffectiveConfigFromConfigProps,
): Promise<McpPortalEffectiveConfigWriteResult> {
	return await buildEffectivePlanFromConfig(props, true);
}

export async function resolveMcpPortalEffectiveConfig(
	props: McpPortalEffectiveConfigProps,
): Promise<McpPortalEffectiveConfigWriteResult> {
	return await buildEffectivePlan(props, true);
}

async function assertEffectiveConfigDirectoryWritable(directoryPath: string): Promise<void> {
	const probeName = `.agent-vm-tool-portal-effective-preflight-${process.pid}-${randomUUID()}`;
	const mcpProbePath = path.join(directoryPath, `${probeName}.mcp.tmp`);
	const portalProbePath = path.join(directoryPath, `${probeName}.portal.tmp`);
	const manifestProbePath = path.join(directoryPath, `${probeName}.manifest.tmp`);
	try {
		await writeNewFileAndSync(mcpProbePath, '{}\n');
		await writeNewFileAndSync(portalProbePath, '{}\n');
		await replaceFileAtomically(manifestProbePath, '{}\n');
		await syncDirectory(directoryPath);
	} finally {
		await Promise.all([
			rm(mcpProbePath, { force: true }),
			rm(portalProbePath, { force: true }),
			rm(manifestProbePath, { force: true }),
			rm(`${manifestProbePath}.${process.pid}.tmp`, { force: true }),
		]);
	}
}

export async function preflightMcpPortalEffectiveConfig(
	props: McpPortalEffectiveConfigProps,
): Promise<McpPortalEffectiveConfigWriteResult> {
	const plan = await buildEffectivePlan(props, true);
	await mkdir(props.effectiveHostConfigDir, { recursive: true, mode: 0o700 });
	await assertEffectiveConfigDirectoryWritable(props.effectiveHostConfigDir);
	return plan;
}

export async function writeMcpPortalEffectiveConfig(
	props: McpPortalEffectiveConfigProps,
): Promise<McpPortalEffectiveConfigWriteResult> {
	const plan = await buildEffectivePlan(props, true);
	await mkdir(props.effectiveHostConfigDir, { recursive: true, mode: 0o700 });
	await writeEffectiveConfigGeneration({
		directoryPath: props.effectiveHostConfigDir,
		mcpConfigContent: `${JSON.stringify(plan.effectiveMcpConfig, null, '\t')}\n`,
		portalConfigContent: `${JSON.stringify(plan.effectivePortalConfig, null, '\t')}\n`,
		toolPortalConfigContent: `${JSON.stringify(plan.effectiveToolPortalConfig, null, '\t')}\n`,
	});

	return plan;
}
