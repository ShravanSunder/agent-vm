import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import {
	loadMcpConfig,
	loadMcpPortalConfig,
	toolPortalConfigSchema,
	type FormattedSecretValue,
	type McpConfig,
	type McpPortalConfig,
	type PortalToolSelector,
	type ToolPortalCapabilityPolicy,
	type ToolPortalConfig,
} from '@agent-vm/config-contracts';
import type { MediatedSecretSpec, SecretRef, SecretResolver } from '@agent-vm/secret-management';

export interface McpPortalEffectiveConfigProps {
	readonly allowedRawEnvSecretNames?: readonly string[];
	readonly authoredConfigDir: string;
	readonly declaredAgentIds?: readonly string[];
	readonly effectiveHostConfigDir: string;
	readonly effectiveVmConfigDir: string;
	readonly includeZoneGitControllerHostAction?: boolean;
	readonly secretResolver: SecretResolver;
	readonly zoneId: string;
}

export interface McpPortalEffectiveConfigFromConfigProps {
	readonly allowedRawEnvSecretNames?: readonly string[];
	readonly declaredAgentIds?: readonly string[];
	readonly effectiveHostConfigDir: string;
	readonly effectiveVmConfigDir: string;
	readonly includeZoneGitControllerHostAction?: boolean;
	readonly mcpConfig: McpConfig;
	readonly portalConfig: McpPortalConfig;
	readonly secretResolver: SecretResolver;
	readonly zoneId: string;
}

export interface McpPortalEffectiveConfigPlan {
	readonly effectiveConfigDir: string;
	readonly effectiveMcpConfig: McpConfig;
	readonly effectivePortalConfig: McpPortalConfig;
	readonly effectiveToolPortalConfig: ToolPortalConfig;
	readonly pluginConfig: { readonly configDir: string };
	readonly requiredGatewayEgressHosts: readonly string[];
	readonly resolvedSecretNames: readonly string[];
	readonly runtimeEnvironment: Readonly<Record<string, string>>;
	readonly runtimeMediatedSecrets: Readonly<Record<string, MediatedSecretSpec>>;
}

export type McpPortalEffectiveConfigWriteResult = Omit<
	McpPortalEffectiveConfigPlan,
	'effectiveMcpConfig' | 'effectivePortalConfig' | 'effectiveToolPortalConfig'
>;

const effectiveConfigManifestFileName = 'tool-portal-effective-manifest.json';

interface EffectiveConfigManifest {
	readonly mcpConfigFile: string;
	readonly portalConfigFile: string;
	readonly schemaVersion: 1;
	readonly toolPortalConfigFile: string;
}

export interface McpPortalEffectiveToolPortalConfigSnapshot {
	readonly effectiveToolPortalConfig: ToolPortalConfig;
	readonly toolPortalConfigPath: string;
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

function buildManagedEffectivePortalConfig(portalConfig: McpPortalConfig): McpPortalConfig {
	const coreConfig = structuredClone(portalConfig);
	delete coreConfig.externalAuth;
	delete coreConfig.mcpProxy;
	for (const agent of Object.values(coreConfig.agents)) {
		delete agent.hmacKey;
	}
	return coreConfig;
}

function assertPortalAgentsMatchDeclaredAgents(props: {
	readonly declaredAgentIds?: readonly string[];
	readonly portalConfig: McpPortalConfig;
	readonly zoneId: string;
}): void {
	if (props.declaredAgentIds === undefined) {
		return;
	}
	const declaredAgentIds = new Set(props.declaredAgentIds);
	for (const agentId of declaredAgentIds) {
		if (props.portalConfig.agents[agentId] !== undefined) {
			continue;
		}
		throw new Error(
			`mcp-portal: zone "${props.zoneId}" declared agent "${agentId}" is missing from mcp-portal.config.jsonc agents.`,
		);
	}
	for (const agentId of Object.keys(props.portalConfig.agents)) {
		if (declaredAgentIds.has(agentId)) {
			continue;
		}
		throw new Error(
			`mcp-portal: zone "${props.zoneId}" mcp-portal.config.jsonc declares undeclared agent "${agentId}".`,
		);
	}
}

function buildManagedEffectiveToolPortalConfig(
	portalConfig: McpPortalConfig,
	options: { readonly includeZoneGitControllerHostAction?: boolean },
): ToolPortalConfig {
	return toolPortalConfigSchema.parse({
		agents: Object.fromEntries(
			Object.entries(portalConfig.agents).map(([agentId, agent]) => [
				agentId,
				{ profile: agent.profile },
			]),
		),
		profiles: Object.fromEntries(
			Object.entries(portalConfig.profiles).map(([profileId, profile]) => [
				profileId,
				{
					capabilities: buildManagedToolPortalCapabilities({
						includeZoneGitControllerHostAction: options.includeZoneGitControllerHostAction === true,
						namespaces: profile.namespaces,
						profileId,
					}),
				},
			]),
		),
		schemaVersion: 1,
	});
}

function selectorAllowsAnyTool(selector: PortalToolSelector): boolean {
	return selector.allow === '*' || selector.allow.length > 0;
}

function assertManagedOpenClawAllowsDirectCallsOnly(props: {
	readonly namespace: string;
	readonly namespacePolicy: McpPortalConfig['profiles'][string]['namespaces'][string];
	readonly profileId: string;
}): void {
	if (!selectorAllowsAnyTool(props.namespacePolicy.calls.requiresApproval)) {
		return;
	}
	throw new Error(
		`mcp-portal: managed OpenClaw Tool Portal profile "${props.profileId}" namespace "${props.namespace}" does not support calls.requiresApproval in this cutover. Move callable tools to calls.withoutApproval or remove the requiresApproval selector until an approval bridge exists.`,
	);
}

function assertManagedOpenClawControllerHostActionPolicy(props: {
	readonly includeZoneGitControllerHostAction: boolean;
	readonly namespacePolicy: McpPortalConfig['profiles'][string]['namespaces'][string];
	readonly profileId: string;
}): void {
	if (!props.includeZoneGitControllerHostAction) {
		throw new Error(
			`mcp-portal: profile "${props.profileId}" uses reserved Tool Portal namespace controller_host_action while zoneGit is disabled.`,
		);
	}
	if (props.namespacePolicy.tools.allow === '*') {
		throw new Error(
			`mcp-portal: managed OpenClaw Tool Portal profile "${props.profileId}" controller_host_action tools must explicitly allow zone_git_push.`,
		);
	}
	if (props.namespacePolicy.calls.withoutApproval.allow === '*') {
		throw new Error(
			`mcp-portal: managed OpenClaw Tool Portal profile "${props.profileId}" controller_host_action calls must explicitly allow zone_git_push.`,
		);
	}
	const allowedTools = new Set(props.namespacePolicy.tools.allow);
	const allowedCalls = new Set(props.namespacePolicy.calls.withoutApproval.allow);
	if (
		allowedTools.size !== 1 ||
		!allowedTools.has('zone_git_push') ||
		allowedCalls.size !== 1 ||
		!allowedCalls.has('zone_git_push')
	) {
		throw new Error(
			`mcp-portal: managed OpenClaw Tool Portal profile "${props.profileId}" controller_host_action supports only zone_git_push in this cutover.`,
		);
	}
}

function buildManagedToolPortalCapabilities(props: {
	readonly includeZoneGitControllerHostAction: boolean;
	readonly namespaces: McpPortalConfig['profiles'][string]['namespaces'];
	readonly profileId: string;
}): ToolPortalConfig['profiles'][string]['capabilities'] {
	const capabilities: Record<string, ToolPortalCapabilityPolicy> = {};
	for (const [namespace, namespacePolicy] of Object.entries(props.namespaces)) {
		assertManagedOpenClawAllowsDirectCallsOnly({
			namespace,
			namespacePolicy,
			profileId: props.profileId,
		});
		if (namespace === 'controller_host_action') {
			assertManagedOpenClawControllerHostActionPolicy({
				includeZoneGitControllerHostAction: props.includeZoneGitControllerHostAction,
				namespacePolicy,
				profileId: props.profileId,
			});
			capabilities[namespace] = {
				backend: { kind: 'controller_host_action' },
				calls: namespacePolicy.calls,
				tools: namespacePolicy.tools,
			};
			continue;
		}
		capabilities[namespace] = {
			backend: { kind: 'mcp_provider' },
			calls: namespacePolicy.calls,
			tools: namespacePolicy.tools,
		};
	}
	return capabilities;
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
	resolveSecrets: boolean,
): Promise<McpPortalEffectiveConfigPlan> {
	assertPortalAgentsMatchDeclaredAgents({
		...(props.declaredAgentIds === undefined ? {} : { declaredAgentIds: props.declaredAgentIds }),
		portalConfig: props.portalConfig,
		zoneId: props.zoneId,
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

	return {
		effectiveConfigDir: props.effectiveHostConfigDir,
		effectiveMcpConfig: { ...props.mcpConfig, providers: effectiveProviders },
		effectivePortalConfig: buildManagedEffectivePortalConfig(props.portalConfig),
		effectiveToolPortalConfig: buildManagedEffectiveToolPortalConfig(
			props.portalConfig,
			props.includeZoneGitControllerHostAction === undefined
				? {}
				: { includeZoneGitControllerHostAction: props.includeZoneGitControllerHostAction },
		),
		pluginConfig: { configDir: props.effectiveVmConfigDir },
		requiredGatewayEgressHosts: [...requiredGatewayEgressHosts].toSorted(),
		resolvedSecretNames: Object.keys(secretRefs).toSorted(),
		runtimeEnvironment,
		runtimeMediatedSecrets,
	};
}

async function buildEffectivePlan(
	props: McpPortalEffectiveConfigProps,
	resolveSecrets: boolean,
): Promise<McpPortalEffectiveConfigPlan> {
	const [mcpConfig, portalConfig] = await Promise.all([
		loadMcpConfig(path.join(props.authoredConfigDir, 'mcp.config.jsonc')),
		loadMcpPortalConfig(path.join(props.authoredConfigDir, 'mcp-portal.config.jsonc')),
	]);
	return await buildEffectivePlanFromConfig(
		{
			effectiveHostConfigDir: props.effectiveHostConfigDir,
			effectiveVmConfigDir: props.effectiveVmConfigDir,
			mcpConfig,
			portalConfig,
			secretResolver: props.secretResolver,
			zoneId: props.zoneId,
			...(props.allowedRawEnvSecretNames === undefined
				? {}
				: { allowedRawEnvSecretNames: props.allowedRawEnvSecretNames }),
			...(props.declaredAgentIds === undefined ? {} : { declaredAgentIds: props.declaredAgentIds }),
			...(props.includeZoneGitControllerHostAction === undefined
				? {}
				: { includeZoneGitControllerHostAction: props.includeZoneGitControllerHostAction }),
		},
		resolveSecrets,
	);
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
): Promise<McpPortalEffectiveConfigPlan> {
	return await buildEffectivePlan(props, false);
}

export async function loadMcpPortalEffectiveToolPortalConfigSnapshot(
	effectiveHostConfigDir: string,
): Promise<McpPortalEffectiveToolPortalConfigSnapshot> {
	const manifest = await readEffectiveConfigManifest(effectiveHostConfigDir);
	const toolPortalConfigPath = resolveEffectiveConfigManifestFilePath(
		effectiveHostConfigDir,
		manifest.toolPortalConfigFile,
		'toolPortalConfigFile',
	);
	const effectiveToolPortalConfig = toolPortalConfigSchema.parse(
		JSON.parse(await readFile(toolPortalConfigPath, 'utf8')),
	);
	return { effectiveToolPortalConfig, toolPortalConfigPath };
}

export async function planMcpPortalEffectiveConfigFromConfig(
	props: McpPortalEffectiveConfigFromConfigProps,
): Promise<McpPortalEffectiveConfigPlan> {
	return await buildEffectivePlanFromConfig(props, false);
}

export async function resolveMcpPortalEffectiveConfigFromConfig(
	props: McpPortalEffectiveConfigFromConfigProps,
): Promise<McpPortalEffectiveConfigPlan> {
	return await buildEffectivePlanFromConfig(props, true);
}

function effectiveConfigWriteResultFromPlan(
	plan: McpPortalEffectiveConfigPlan,
): McpPortalEffectiveConfigWriteResult {
	return {
		effectiveConfigDir: plan.effectiveConfigDir,
		pluginConfig: plan.pluginConfig,
		requiredGatewayEgressHosts: plan.requiredGatewayEgressHosts,
		resolvedSecretNames: plan.resolvedSecretNames,
		runtimeEnvironment: plan.runtimeEnvironment,
		runtimeMediatedSecrets: plan.runtimeMediatedSecrets,
	};
}

export async function resolveMcpPortalEffectiveConfig(
	props: McpPortalEffectiveConfigProps,
): Promise<McpPortalEffectiveConfigWriteResult> {
	return effectiveConfigWriteResultFromPlan(await buildEffectivePlan(props, true));
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
	return effectiveConfigWriteResultFromPlan(plan);
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

	return effectiveConfigWriteResultFromPlan(plan);
}
