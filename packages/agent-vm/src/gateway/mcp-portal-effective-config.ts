import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import {
	loadMcpConfig,
	loadMcpPortalConfig,
	type McpConfig,
	type McpPortalConfig,
	type SecretValue,
} from '@agent-vm/config-contracts';
import type { MediatedSecretSpec, SecretRef, SecretResolver } from '@agent-vm/secrets';

export interface McpPortalEffectiveConfigProps {
	readonly allowedRawEnvSecretNames?: readonly string[];
	readonly authoredConfigDir: string;
	readonly effectiveHostConfigDir: string;
	readonly effectiveVmConfigDir: string;
	readonly secretResolver: SecretResolver;
	readonly zoneId: string;
}

export interface McpPortalEffectiveConfigPlan {
	readonly effectiveConfigDir: string;
	readonly effectiveMcpConfig: McpConfig;
	readonly effectivePortalConfig: McpPortalConfig;
	readonly pluginConfig: { readonly configDir: string };
	readonly requiredGatewayEgressHosts: readonly string[];
	readonly resolvedSecretNames: readonly string[];
	readonly runtimeEnvironment: Readonly<Record<string, string>>;
	readonly runtimeMediatedSecrets: Readonly<Record<string, MediatedSecretSpec>>;
}

export type McpPortalEffectiveConfigWriteResult = Omit<
	McpPortalEffectiveConfigPlan,
	'effectiveMcpConfig' | 'effectivePortalConfig'
>;

const effectiveConfigManifestFileName = 'mcp-portal-effective-manifest.json';

interface EffectiveConfigManifest {
	readonly mcpConfigFile: string;
	readonly portalConfigFile: string;
	readonly schemaVersion: 1;
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
): Readonly<Record<string, SecretValue>> {
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

function providerSecretRef(secret: SecretValue): SecretRef {
	if (secret.source === 'environment') {
		return { ref: secret.name, source: 'environment' };
	}
	return { ref: secret.ref, source: '1password' };
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

async function buildEffectivePlan(
	props: McpPortalEffectiveConfigProps,
	resolveSecrets: boolean,
): Promise<McpPortalEffectiveConfigPlan> {
	const [mcpConfig, portalConfig] = await Promise.all([
		loadMcpConfig(path.join(props.authoredConfigDir, 'mcp.config.jsonc')),
		loadMcpPortalConfig(path.join(props.authoredConfigDir, 'mcp-portal.config.jsonc')),
	]);
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

	for (const [providerName, provider] of Object.entries(mcpConfig.providers)) {
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
			transportSecrets[secretName] = { name: envName, source: 'environment' };
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
		effectiveMcpConfig: { ...mcpConfig, providers: effectiveProviders },
		effectivePortalConfig: buildManagedEffectivePortalConfig(portalConfig),
		pluginConfig: { configDir: props.effectiveVmConfigDir },
		requiredGatewayEgressHosts: [...requiredGatewayEgressHosts].toSorted(),
		resolvedSecretNames: Object.keys(secretRefs).toSorted(),
		runtimeEnvironment,
		runtimeMediatedSecrets,
	};
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
		/^mcp-portal\.config\.[0-9a-f-]+\.jsonc$/u.test(fileName)
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
}): Promise<void> {
	const generation = randomUUID();
	const manifest: EffectiveConfigManifest = {
		mcpConfigFile: `mcp.config.${generation}.jsonc`,
		portalConfigFile: `mcp-portal.config.${generation}.jsonc`,
		schemaVersion: 1,
	};
	const currentFileNames = new Set([manifest.mcpConfigFile, manifest.portalConfigFile]);

	await writeNewFileAndSync(
		path.join(props.directoryPath, manifest.mcpConfigFile),
		props.mcpConfigContent,
	);
	await writeNewFileAndSync(
		path.join(props.directoryPath, manifest.portalConfigFile),
		props.portalConfigContent,
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

export async function writeMcpPortalEffectiveConfig(
	props: McpPortalEffectiveConfigProps,
): Promise<McpPortalEffectiveConfigWriteResult> {
	const plan = await buildEffectivePlan(props, true);
	await mkdir(props.effectiveHostConfigDir, { recursive: true, mode: 0o700 });
	await writeEffectiveConfigGeneration({
		directoryPath: props.effectiveHostConfigDir,
		mcpConfigContent: `${JSON.stringify(plan.effectiveMcpConfig, null, '\t')}\n`,
		portalConfigContent: `${JSON.stringify(plan.effectivePortalConfig, null, '\t')}\n`,
	});

	return {
		effectiveConfigDir: plan.effectiveConfigDir,
		pluginConfig: plan.pluginConfig,
		requiredGatewayEgressHosts: plan.requiredGatewayEgressHosts,
		resolvedSecretNames: plan.resolvedSecretNames,
		runtimeEnvironment: plan.runtimeEnvironment,
		runtimeMediatedSecrets: plan.runtimeMediatedSecrets,
	};
}
