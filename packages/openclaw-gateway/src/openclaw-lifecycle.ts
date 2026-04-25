import fs from 'node:fs/promises';
import path from 'node:path';

import type {
	BuildGatewayVmSpecOptions,
	GatewayLifecycle,
	GatewayProcessSpec,
	GatewayZoneConfig,
	GatewayVmSpec,
} from '@agent-vm/gateway-interface';
import {
	buildGatewaySessionLabel as buildGatewaySessionLabelValue,
	splitResolvedGatewaySecrets,
} from '@agent-vm/gateway-interface';
import {
	type SecretRef,
	type SecretResolver,
	writeFileAtomically,
} from '@agent-vm/gondolin-adapter';

const effectiveOpenClawConfigFileName = 'effective-openclaw.json';
const effectiveOpenClawConfigVmPath = `/home/openclaw/.openclaw/state/${effectiveOpenClawConfigFileName}`;
const openClawShellEnvFilePath = '/etc/profile.d/openclaw-env.sh';

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildGatewayTcpHosts(
	zone: GatewayZoneConfig,
	controllerPort: number,
	tcpPool: { readonly basePort: number; readonly size: number },
): Record<string, string> {
	const tcpHosts: Record<string, string> = {
		'controller.vm.host:18800': `127.0.0.1:${controllerPort}`,
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
	_zone: GatewayZoneConfig,
	_resolvedSecrets: Record<string, string>,
): string {
	const environmentLines = [
		'export OPENCLAW_HOME=/home/openclaw',
		`export OPENCLAW_CONFIG_PATH=${effectiveOpenClawConfigVmPath}`,
		'export OPENCLAW_STATE_DIR=/home/openclaw/.openclaw/state',
		'export NODE_EXTRA_CA_CERTS=/run/gondolin/ca-certificates.crt',
	];

	return (
		`mkdir -p /root /etc/profile.d && cat > ${openClawShellEnvFilePath} << ENVEOF\n` +
		environmentLines.join('\n') +
		'\nENVEOF\n' +
		`chmod 644 ${openClawShellEnvFilePath} && ` +
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

async function writeAuthProfilesIfConfigured(
	zone: GatewayZoneConfig,
	secretResolver: SecretResolver,
): Promise<void> {
	const authProfilesSecretCandidate: unknown = zone.gateway.authProfilesRef;
	if (authProfilesSecretCandidate === undefined) {
		return;
	}
	if (!isSourceAwareSecretReference(authProfilesSecretCandidate)) {
		throw new Error(`Zone '${zone.id}' has an invalid authProfilesRef shape.`);
	}
	const authProfilesSecret = authProfilesSecretCandidate;

	try {
		const authProfilesDirectory = path.join(zone.gateway.stateDir, 'agents', 'main', 'agent');
		await fs.mkdir(authProfilesDirectory, { recursive: true, mode: 0o700 });
		await fs.chmod(authProfilesDirectory, 0o700);
		const authProfiles = await secretResolver.resolve(toSecretRef(authProfilesSecret));
		await writeFileAtomically(
			path.join(authProfilesDirectory, 'auth-profiles.json'),
			authProfiles,
			{ mode: 0o600 },
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Failed to write OpenClaw auth profiles for zone '${zone.id}' from '${describeSecretReference(authProfilesSecret)}': ${message}`,
			{ cause: error },
		);
	}
}

async function writeEffectiveOpenClawConfig(
	zone: GatewayZoneConfig,
	secretResolver: SecretResolver,
): Promise<void> {
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
		const gatewayToken = await secretResolver.resolve(toSecretRef(gatewayTokenSecret));
		const rawBaseConfig = await fs.readFile(zone.gateway.config, 'utf8');
		const parsedBaseConfig: unknown = JSON.parse(rawBaseConfig);
		if (!isObjectRecord(parsedBaseConfig)) {
			throw new Error(`OpenClaw config at '${zone.gateway.config}' must be a JSON object.`);
		}
		const config = isObjectRecord(parsedBaseConfig.gateway) ? parsedBaseConfig.gateway : {};
		const existingAuthConfig = isObjectRecord(config.auth) ? config.auth : {};
		const effectiveConfig = {
			...parsedBaseConfig,
			gateway: {
				...config,
				auth: {
					...existingAuthConfig,
					mode: 'token',
					token: gatewayToken,
				},
			},
		};
		const effectiveConfigPath = getEffectiveOpenClawConfigHostPath(zone);
		await fs.mkdir(zone.gateway.stateDir, { recursive: true, mode: 0o700 });
		await fs.chmod(zone.gateway.stateDir, 0o700);
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
		buildLoginCommand: (provider: string): string =>
			`openclaw models auth login --provider ${shellQuote(provider)}`,
	},

	buildVmSpec({
		controllerPort,
		projectNamespace,
		resolvedSecrets,
		tcpPool,
		zone,
	}: BuildGatewayVmSpecOptions): GatewayVmSpec {
		const configDirectory = path.dirname(path.resolve(zone.gateway.config));
		const { environmentSecrets, mediatedSecrets } = splitResolvedGatewaySecrets(
			zone,
			resolvedSecrets,
		);
		const { OPENCLAW_GATEWAY_TOKEN: _gatewayToken, ...environmentSecretsWithoutGatewayToken } =
			environmentSecrets;

		return {
			allowedHosts: [...zone.allowedHosts],
			environment: {
				HOME: '/home/openclaw',
				NODE_EXTRA_CA_CERTS: '/run/gondolin/ca-certificates.crt',
				OPENCLAW_CONFIG_PATH: effectiveOpenClawConfigVmPath,
				OPENCLAW_HOME: '/home/openclaw',
				OPENCLAW_STATE_DIR: '/home/openclaw/.openclaw/state',
				...environmentSecretsWithoutGatewayToken,
			},
			mediatedSecrets,
			rootfsMode: 'cow',
			sessionLabel: buildGatewaySessionLabelValue(projectNamespace, zone.id),
			tcpHosts: buildGatewayTcpHosts(zone, controllerPort, tcpPool),
			vfsMounts: {
				'/home/openclaw/.openclaw/config': {
					hostPath: configDirectory,
					kind: 'realfs',
				},
				'/home/openclaw/.openclaw/state': {
					hostPath: zone.gateway.stateDir,
					kind: 'realfs',
				},
				'/home/openclaw/workspace': {
					hostPath: zone.gateway.workspaceDir,
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
			startCommand:
				'cd /home/openclaw && nohup openclaw gateway --port 18789 > /tmp/openclaw.log 2>&1 &',
			healthCheck: { type: 'http', port: 18789, path: '/' },
			guestListenPort: 18789,
			logPath: '/tmp/openclaw.log',
		};
	},

	async prepareHostState(zone: GatewayZoneConfig, secretResolver: SecretResolver): Promise<void> {
		await writeEffectiveOpenClawConfig(zone, secretResolver);
		await writeAuthProfilesIfConfigured(zone, secretResolver);
	},
};
