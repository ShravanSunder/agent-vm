import { chmod, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type {
	BuildGatewayVmSpecOptions,
	GatewayLifecycle,
	GatewayProcessSpec,
	GatewayZoneConfig,
	GatewayVmSpec,
	SplitResolvedGatewaySecretsResult,
} from '@agent-vm/gateway-interface';
import {
	buildGatewaySessionLabel as buildGatewaySessionLabelValue,
	composeNodeOptions,
	controllerVmHost,
	FORCE_IPV4_EGRESS_NODE_OPTIONS,
	gatewayVmAllowedHosts,
	mergeRuntimeGatewaySecrets,
	splitResolvedGatewaySecrets,
} from '@agent-vm/gateway-interface';
import { writeFileAtomically } from '@agent-vm/gondolin-adapter';
import type { SecretRef, SecretResolver } from '@agent-vm/secrets';

const effectiveOpenClawConfigFileName = 'effective-openclaw.json';
const effectiveOpenClawConfigVmPath = `/home/openclaw/.openclaw/state/${effectiveOpenClawConfigFileName}`;
const openClawStateDirVmPath = '/home/openclaw/.openclaw/state';
const openClawCacheDirVmPath = '/home/openclaw/.openclaw/cache';
const openClawZoneFilesDirVmPath = '/zone';
const agentVmLogsDirVmPath = '/agent-vm/logs';
const openClawRuntimeLogFileVmPath = `${agentVmLogsDirVmPath}/openclaw-YYYY-MM-DD.log`;
const openClawGatewayBootLogFileVmPath = `${agentVmLogsDirVmPath}/gateway-boot-latest.log`;
const openClawShellEnvFilePath = '/etc/profile.d/openclaw-env.sh';
const openClawRuntimeSecretsEnvFilePath = '/run/openclaw/secrets.env';
const openClawGatewayTokenEnvVar = 'OPENCLAW_GATEWAY_TOKEN';

interface OpenClawSecretRef {
	readonly id: string;
	readonly provider: string;
	readonly source: 'env';
}

const openClawGatewayTokenSecretRef: OpenClawSecretRef = {
	id: openClawGatewayTokenEnvVar,
	provider: 'default',
	source: 'env',
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildGatewayTcpHosts(
	zone: GatewayZoneConfig,
	controllerPort: number,
	tcpPool: { readonly basePort: number; readonly size: number },
): Record<string, string> {
	const tcpHosts: Record<string, string> = {
		[`${controllerVmHost}:18800`]: `127.0.0.1:${controllerPort}`,
	};

	for (let slot = 0; slot < tcpPool.size; slot += 1) {
		tcpHosts[`tool-${slot}.vm.host:22`] = `127.0.0.1:${tcpPool.basePort + slot}`;
	}

	for (const websocketHost of zone.websocketBypass) {
		tcpHosts[websocketHost] = websocketHost;
	}

	return tcpHosts;
}

function buildOpenClawBootstrapCommand(
	zone: GatewayZoneConfig,
	resolvedSecrets: Record<string, string>,
): string {
	const { environmentSecrets } = mergeRuntimeGatewaySecrets(
		splitAllowedOpenClawGatewaySecrets(zone, resolvedSecrets, 'openclaw-bootstrap-raw-env-secrets'),
		{
			logPrefix: 'openclaw-bootstrap-runtime-secrets',
			runtimeEnvironment: zone.runtimeEnvironment,
			runtimeMediatedSecrets: zone.runtimeMediatedSecrets,
		},
	);
	assertAllowedOpenClawEnvironmentSecrets(
		zone,
		environmentSecrets,
		'openclaw-bootstrap-runtime-raw-env-secrets',
	);
	const environmentLines = [
		'export OPENCLAW_HOME=/home/openclaw',
		`export OPENCLAW_CONFIG_PATH=${effectiveOpenClawConfigVmPath}`,
		`export OPENCLAW_STATE_DIR=${openClawStateDirVmPath}`,
		'export PNPM_HOME=/pnpm',
		'export PATH=/pnpm:$PATH',
		'export TMPDIR=/work/tmp',
		'export TMP=/work/tmp',
		'export TEMP=/work/tmp',
		'export npm_config_cache=/work/cache/npm',
		'export pnpm_config_store_dir=/work/cache/pnpm/store',
		'export PIP_CACHE_DIR=/work/cache/pip',
		'export UV_CACHE_DIR=/work/cache/uv',
		'export NODE_EXTRA_CA_CERTS=/run/gondolin/ca-certificates.crt',
		// Prepend forced IPv4-preference flags to any pre-existing
		// NODE_OPTIONS. The whole RHS is double-quoted so the
		// substitution result is treated as one assignment value
		// (no word splitting). See FORCE_IPV4_EGRESS_NODE_OPTIONS
		// in @agent-vm/gateway-interface for the rationale.
		`export NODE_OPTIONS="${FORCE_IPV4_EGRESS_NODE_OPTIONS}\${NODE_OPTIONS:+ \${NODE_OPTIONS}}"`,
	];
	const secretEnvironmentNames = Object.entries({
		...environmentSecrets,
		...zone.runtimeEnvironment,
	}).map(([secretName, secretValue]) => {
		assertShellSafeEnvName(secretName);
		assertShellProfileSafeSecretValue(secretName, secretValue);
		return secretName;
	});
	const secretsFileCommand =
		secretEnvironmentNames.length === 0
			? `: > ${openClawRuntimeSecretsEnvFilePath} && `
			: `{ ${secretEnvironmentNames.map(runtimeSecretExportCommand).join('; ')}; } > ${openClawRuntimeSecretsEnvFilePath} && `;
	const sshConfigLines = ['Host tool-*.vm.host', '  AddressFamily inet'];
	const sshConfigCommand =
		`mkdir -p /root/.ssh /home/openclaw/.ssh && ` +
		`printf '%s\\n' ${sshConfigLines.map((line) => shellQuote(line)).join(' ')} > /root/.ssh/config && ` +
		'cp /root/.ssh/config /home/openclaw/.ssh/config && ' +
		'chown -R openclaw:openclaw /home/openclaw/.ssh && ' +
		'chmod 700 /root/.ssh /home/openclaw/.ssh && ' +
		'chmod 600 /root/.ssh/config /home/openclaw/.ssh/config && ';

	return (
		`mkdir -p /root /etc/profile.d /run/openclaw /work/tmp /work/cache/npm /work/cache/pnpm/store /work/cache/pip /work/cache/uv && chown -R openclaw:openclaw /work && cat > ${openClawShellEnvFilePath} << 'ENVEOF'\n` +
		environmentLines.join('\n') +
		'\nENVEOF\n' +
		`chmod 644 ${openClawShellEnvFilePath} && ` +
		secretsFileCommand +
		`chmod 600 ${openClawRuntimeSecretsEnvFilePath} && ` +
		sshConfigCommand +
		'touch /root/.bashrc && ' +
		`grep -qxF 'source ${openClawShellEnvFilePath}' /root/.bashrc || echo 'source ${openClawShellEnvFilePath}' >> /root/.bashrc && ` +
		'touch /root/.bash_profile && ' +
		"grep -qxF 'source /root/.bashrc' /root/.bash_profile || echo 'source /root/.bashrc' >> /root/.bash_profile"
	);
}

function getEffectiveOpenClawConfigHostPath(zone: GatewayZoneConfig): string {
	return path.join(zone.gateway.stateDir, effectiveOpenClawConfigFileName);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function includesShellUnsafeControlByte(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
			return true;
		}
	}
	return false;
}

function assertShellSafeEnvName(secretName: string): void {
	if (!/^[_A-Za-z][_0-9A-Za-z]*$/u.test(secretName)) {
		throw new Error(
			`OpenClaw env-injected gateway secret '${secretName}' must be a shell-safe environment variable name.`,
		);
	}
}

function assertShellProfileSafeSecretValue(secretName: string, value: string): void {
	if (includesShellUnsafeControlByte(value)) {
		throw new Error(
			`OpenClaw env-injected gateway secret '${secretName}' must be a single-line value without control bytes. Use http-mediation for secrets that require structured transport.`,
		);
	}
}

function runtimeSecretExportCommand(secretName: string): string {
	const runtimeSecretValue = `"\${${secretName}?missing runtime secret ${secretName}}"`;
	const exportLine = `export ${secretName}=${runtimeSecretValue}`;
	return `: ${runtimeSecretValue} && printf '%s\\n' ${shellQuote(exportLine)}`;
}

function assertAllowedOpenClawEnvironmentSecrets(
	zone: GatewayZoneConfig,
	environmentSecrets: Readonly<Record<string, string>>,
	logPrefix: string,
): void {
	if (zone.gateway.type !== 'openclaw') {
		throw new Error(`OpenClaw lifecycle cannot build gateway type '${zone.gateway.type}'.`);
	}
	const allowedRawEnvSecrets = new Set([
		openClawGatewayTokenEnvVar,
		...(zone.gateway.rawEnvSecrets ?? []),
	]);
	for (const secretName of Object.keys(environmentSecrets)) {
		if (allowedRawEnvSecrets.has(secretName)) {
			continue;
		}
		throw new Error(
			`[${logPrefix}] OpenClaw env secret '${secretName}' must be listed in gateway.rawEnvSecrets or use injection 'http-mediation'.`,
		);
	}
}

function splitAllowedOpenClawGatewaySecrets(
	zone: GatewayZoneConfig,
	resolvedSecrets: Record<string, string>,
	logPrefix: string,
): SplitResolvedGatewaySecretsResult {
	const splitSecrets = splitResolvedGatewaySecrets(zone, resolvedSecrets);
	assertAllowedOpenClawEnvironmentSecrets(zone, splitSecrets.environmentSecrets, logPrefix);
	return splitSecrets;
}

type SourceAwareSecretReference =
	| {
			readonly source: 'environment';
			readonly envVar: string;
	  }
	| {
			readonly source: '1password';
			readonly ref: string;
	  };

function isSourceAwareSecretReference(value: unknown): value is SourceAwareSecretReference {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	if (!('source' in value) || typeof value.source !== 'string') {
		return false;
	}

	if (value.source === 'environment') {
		return 'envVar' in value && typeof value.envVar === 'string';
	}

	if (value.source === '1password') {
		return 'ref' in value && typeof value.ref === 'string';
	}

	return false;
}

function toSecretRef(secret: SourceAwareSecretReference): SecretRef {
	return secret.source === 'environment'
		? {
				source: 'environment',
				ref: secret.envVar,
			}
		: {
				source: '1password',
				ref: secret.ref,
			};
}

function describeSecretReference(secret: SourceAwareSecretReference): string {
	return secret.source === 'environment' ? secret.envVar : secret.ref;
}

function buildEffectiveSecretsConfig(
	parsedBaseConfig: Record<string, unknown>,
): Record<string, unknown> {
	const existingSecretsConfig = isObjectRecord(parsedBaseConfig.secrets)
		? parsedBaseConfig.secrets
		: {};
	const existingProvidersConfig = isObjectRecord(existingSecretsConfig.providers)
		? existingSecretsConfig.providers
		: {};

	return {
		...existingSecretsConfig,
		providers: {
			...existingProvidersConfig,
			default: {
				source: 'env',
			},
		},
	};
}

function buildEffectiveMcpPortalPluginConfig(
	_existingPluginConfig: Record<string, unknown>,
	runtimeConfig: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	return {
		...runtimeConfig,
	};
}

function buildEffectivePluginsConfig(
	parsedBaseConfig: Record<string, unknown>,
	runtimePluginConfigs: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined,
): Record<string, unknown> {
	const existingPluginsConfig = isObjectRecord(parsedBaseConfig.plugins)
		? parsedBaseConfig.plugins
		: {};
	const existingEntriesConfig = isObjectRecord(existingPluginsConfig.entries)
		? existingPluginsConfig.entries
		: {};
	const runtimeEntriesConfig = Object.fromEntries(
		Object.entries(runtimePluginConfigs ?? {}).map(([pluginId, runtimeConfig]) => {
			const existingEntryConfig = isObjectRecord(existingEntriesConfig[pluginId])
				? existingEntriesConfig[pluginId]
				: {};
			const existingPluginConfig = isObjectRecord(existingEntryConfig.config)
				? existingEntryConfig.config
				: {};
			const config =
				pluginId === 'mcp-portal'
					? buildEffectiveMcpPortalPluginConfig(existingPluginConfig, runtimeConfig)
					: {
							...existingPluginConfig,
							...runtimeConfig,
						};
			return [
				pluginId,
				{
					...existingEntryConfig,
					config,
				},
			] as const;
		}),
	);

	return {
		...existingPluginsConfig,
		entries: {
			...existingEntriesConfig,
			...runtimeEntriesConfig,
		},
	};
}

function buildEffectiveMcpConfig(
	parsedBaseConfig: Record<string, unknown>,
	runtimeMcpServers: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
	const existingMcpConfig = isObjectRecord(parsedBaseConfig.mcp) ? parsedBaseConfig.mcp : {};
	const existingServersConfig = isObjectRecord(existingMcpConfig.servers)
		? existingMcpConfig.servers
		: {};
	return {
		...existingMcpConfig,
		servers: {
			...existingServersConfig,
			...runtimeMcpServers,
		},
	};
}

function buildEffectiveLoggingConfig(
	parsedBaseConfig: Record<string, unknown>,
): Record<string, unknown> {
	const existingLoggingConfig = isObjectRecord(parsedBaseConfig.logging)
		? parsedBaseConfig.logging
		: {};

	return {
		file: openClawRuntimeLogFileVmPath,
		...existingLoggingConfig,
	};
}

async function writeAuthProfilesIfConfigured(
	zone: GatewayZoneConfig,
	secretResolver: SecretResolver,
): Promise<void> {
	const authProfilesByAgent = {
		...(zone.gateway.authProfilesRef ? { main: zone.gateway.authProfilesRef } : {}),
		...(zone.gateway.type === 'openclaw' ? (zone.gateway.authProfilesByAgent ?? {}) : {}),
	};

	const writeResults = await Promise.allSettled(
		Object.entries(authProfilesByAgent).map(async ([agentId, authProfilesSecretCandidate]) => {
			if (!isSourceAwareSecretReference(authProfilesSecretCandidate)) {
				throw new Error(
					`Zone '${zone.id}' has an invalid auth profile shape for agent '${agentId}'.`,
				);
			}
			const authProfilesSecret = authProfilesSecretCandidate;

			try {
				const authProfilesDirectory = path.join(zone.gateway.stateDir, 'agents', agentId, 'agent');
				await mkdir(authProfilesDirectory, { recursive: true, mode: 0o700 });
				await chmod(authProfilesDirectory, 0o700);
				const authProfiles = await secretResolver.resolve(toSecretRef(authProfilesSecret));
				await writeFileAtomically(
					path.join(authProfilesDirectory, 'auth-profiles.json'),
					authProfiles,
					{ mode: 0o600 },
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(
					`Failed to write OpenClaw auth profiles for zone '${zone.id}' agent '${agentId}' from '${describeSecretReference(authProfilesSecret)}': ${message}`,
					{ cause: error },
				);
			}
		}),
	);
	const writeErrors = writeResults
		.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
		.map((result) =>
			result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
		);
	if (writeErrors.length > 0) {
		throw new AggregateError(
			writeErrors,
			`Failed to write ${String(writeErrors.length)} OpenClaw auth profile file(s) for zone '${zone.id}'.`,
		);
	}
}

async function writeEffectiveOpenClawConfig(zone: GatewayZoneConfig): Promise<void> {
	const gatewayTokenSecret = zone.secrets.OPENCLAW_GATEWAY_TOKEN;
	if (!gatewayTokenSecret) {
		throw new Error(
			`Zone '${zone.id}' secret 'OPENCLAW_GATEWAY_TOKEN' is missing. Add an explicit 1Password or environment reference such as 'op://agent-vm/${zone.id}-gateway-auth/password'.`,
		);
	}
	if (!isSourceAwareSecretReference(gatewayTokenSecret)) {
		throw new Error(`Zone '${zone.id}' secret 'OPENCLAW_GATEWAY_TOKEN' has an invalid shape.`);
	}

	try {
		if (gatewayTokenSecret.source === '1password' && !gatewayTokenSecret.ref) {
			throw new Error(
				`Zone '${zone.id}' secret 'OPENCLAW_GATEWAY_TOKEN' is missing 'ref'. Add an explicit 1Password reference such as 'op://agent-vm/${zone.id}-gateway-auth/password'.`,
			);
		}
		if (gatewayTokenSecret.source === 'environment' && !gatewayTokenSecret.envVar) {
			throw new Error(
				`Zone '${zone.id}' secret 'OPENCLAW_GATEWAY_TOKEN' is missing 'envVar'. Add an explicit environment variable name.`,
			);
		}
		const rawBaseConfig = await readFile(zone.gateway.config, 'utf8');
		const parsedBaseConfig: unknown = JSON.parse(rawBaseConfig);
		if (!isObjectRecord(parsedBaseConfig)) {
			throw new Error(`OpenClaw config at '${zone.gateway.config}' must be a JSON object.`);
		}
		const runtimePluginConfigs = {
			...zone.runtimePluginConfigs,
		};
		const config = isObjectRecord(parsedBaseConfig.gateway) ? parsedBaseConfig.gateway : {};
		const existingAuthConfig = isObjectRecord(config.auth) ? config.auth : {};
		const effectiveConfig = {
			...parsedBaseConfig,
			logging: buildEffectiveLoggingConfig(parsedBaseConfig),
			gateway: {
				...config,
				auth: {
					...existingAuthConfig,
					mode: 'token',
					token: openClawGatewayTokenSecretRef,
				},
			},
			meta: {
				...(isObjectRecord(parsedBaseConfig.meta) ? parsedBaseConfig.meta : {}),
				lastTouchedAt: new Date().toISOString(),
				lastTouchedVersion: 'agent-vm',
			},
			mcp: buildEffectiveMcpConfig(parsedBaseConfig, zone.runtimeMcpServers),
			plugins: buildEffectivePluginsConfig(parsedBaseConfig, runtimePluginConfigs),
			secrets: buildEffectiveSecretsConfig(parsedBaseConfig),
		};
		const effectiveConfigPath = getEffectiveOpenClawConfigHostPath(zone);
		await mkdir(zone.gateway.stateDir, { recursive: true, mode: 0o700 });
		await chmod(zone.gateway.stateDir, 0o700);
		await writeFileAtomically(
			effectiveConfigPath,
			`${JSON.stringify(effectiveConfig, null, 2)}\n`,
			{ mode: 0o600 },
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Failed to write effective OpenClaw config for zone '${zone.id}' from '${zone.gateway.config}' using secret '${describeSecretReference(gatewayTokenSecret)}': ${message}`,
			{ cause: error },
		);
	}
}

export const openclawLifecycle: GatewayLifecycle = {
	authConfig: {
		listProvidersCommand: 'openclaw models auth list --format plain 2>/dev/null || echo ""',
		buildLoginCommand: (
			provider: string,
			options: {
				readonly agentId?: string;
				readonly deviceCode?: boolean;
				readonly setDefault?: boolean;
			} = {},
		): string =>
			[
				'openclaw models auth',
				...(options.agentId ? [`--agent ${shellQuote(options.agentId)}`] : []),
				`login --provider ${shellQuote(provider)}`,
				...(options.deviceCode === true ? ['--device-code'] : []),
				...(options.setDefault === true ? ['--set-default'] : []),
			].join(' '),
	},

	buildVmSpec({
		controllerPort,
		gatewayCacheDir,
		projectNamespace,
		resolvedSecrets,
		runtimeDir,
		tcpPool,
		zone,
	}: BuildGatewayVmSpecOptions): GatewayVmSpec {
		if (zone.gateway.type !== 'openclaw') {
			throw new Error(`OpenClaw lifecycle cannot build gateway type '${zone.gateway.type}'.`);
		}
		const configDirectory = path.dirname(path.resolve(zone.gateway.config));
		const { environmentSecrets, mediatedSecrets } = mergeRuntimeGatewaySecrets(
			splitAllowedOpenClawGatewaySecrets(zone, resolvedSecrets, 'openclaw-vm-raw-env-secrets'),
			{
				logPrefix: 'openclaw-vm-runtime-secrets',
				runtimeEnvironment: zone.runtimeEnvironment,
				runtimeMediatedSecrets: zone.runtimeMediatedSecrets,
			},
		);
		assertAllowedOpenClawEnvironmentSecrets(
			zone,
			environmentSecrets,
			'openclaw-vm-runtime-raw-env-secrets',
		);

		return {
			allowedHosts: gatewayVmAllowedHosts(zone.egressHosts),
			environment: {
				HOME: '/home/openclaw',
				NODE_EXTRA_CA_CERTS: '/run/gondolin/ca-certificates.crt',
				OPENCLAW_CONFIG_PATH: effectiveOpenClawConfigVmPath,
				OPENCLAW_HOME: '/home/openclaw',
				OPENCLAW_STATE_DIR: openClawStateDirVmPath,
				PATH: `/pnpm:${process.env.PATH ?? ''}`,
				PIP_CACHE_DIR: '/work/cache/pip',
				PNPM_HOME: '/pnpm',
				TEMP: '/work/tmp',
				TMP: '/work/tmp',
				TMPDIR: '/work/tmp',
				UV_CACHE_DIR: '/work/cache/uv',
				npm_config_cache: '/work/cache/npm',
				pnpm_config_store_dir: '/work/cache/pnpm/store',
				...environmentSecrets,
				// NODE_OPTIONS goes AFTER the spread so a user-supplied
				// NODE_OPTIONS in environmentSecrets cannot drop the
				// forced IPv4-preference flags. composeNodeOptions
				// preserves the user value as additional flags.
				NODE_OPTIONS: composeNodeOptions(environmentSecrets.NODE_OPTIONS),
			},
			mediatedSecrets: {
				...mediatedSecrets,
			},
			rootfsMode: 'cow',
			sessionLabel: buildGatewaySessionLabelValue(projectNamespace, zone.id),
			tcpHosts: buildGatewayTcpHosts(zone, controllerPort, tcpPool),
			vfsMounts: {
				'/home/openclaw/.openclaw/config': {
					hostPath: configDirectory,
					kind: 'realfs',
				},
				[openClawCacheDirVmPath]: {
					hostPath: gatewayCacheDir,
					kind: 'realfs',
				},
				'/home/openclaw/.openclaw/state': {
					hostPath: zone.gateway.stateDir,
					kind: 'realfs',
				},
				[openClawZoneFilesDirVmPath]: {
					hostPath: zone.gateway.zoneFilesDir,
					kind: 'realfs',
				},
				[agentVmLogsDirVmPath]: {
					hostPath: path.join(runtimeDir, 'zones', zone.id, 'logs'),
					kind: 'realfs',
				},
			},
		};
	},

	buildProcessSpec(
		zone: GatewayZoneConfig,
		resolvedSecrets: Record<string, string>,
	): GatewayProcessSpec {
		return {
			bootstrapCommand: buildOpenClawBootstrapCommand(zone, resolvedSecrets),
			startCommand: `set -a && . ${openClawRuntimeSecretsEnvFilePath} && set +a && cd /home/openclaw && nohup openclaw gateway --port 18789 > ${openClawGatewayBootLogFileVmPath} 2>&1 &`,
			healthCheck: {
				type: 'http',
				port: 18789,
				path: '/readyz',
			},
			guestListenPort: 18789,
			logPath: openClawGatewayBootLogFileVmPath,
		};
	},

	async prepareHostState(zone: GatewayZoneConfig, secretResolver: SecretResolver): Promise<void> {
		await writeEffectiveOpenClawConfig(zone);
		await writeAuthProfilesIfConfigured(zone, secretResolver);
	},
};
