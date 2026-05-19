import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
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
	return coreConfig;
}

function providerSecretRef(secret: SecretValue): SecretRef {
	if (secret.source === 'environment') {
		return { ref: secret.name, source: 'environment' };
	}
	return { ref: secret.ref, source: '1password' };
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
	const secretRefs: Record<string, SecretRef> = {};
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
			if (Object.hasOwn(secretRefs, envName)) {
				throw new Error(`mcp-portal: generated secret environment name collision for ${envName}.`);
			}
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
	await writeFileAtomically(
		path.join(props.effectiveHostConfigDir, 'mcp.config.jsonc'),
		`${JSON.stringify(plan.effectiveMcpConfig, null, '\t')}\n`,
	);
	await writeFileAtomically(
		path.join(props.effectiveHostConfigDir, 'mcp-portal.config.jsonc'),
		`${JSON.stringify(plan.effectivePortalConfig, null, '\t')}\n`,
	);

	return {
		effectiveConfigDir: plan.effectiveConfigDir,
		pluginConfig: plan.pluginConfig,
		requiredGatewayEgressHosts: plan.requiredGatewayEgressHosts,
		resolvedSecretNames: plan.resolvedSecretNames,
		runtimeEnvironment: plan.runtimeEnvironment,
		runtimeMediatedSecrets: plan.runtimeMediatedSecrets,
	};
}
