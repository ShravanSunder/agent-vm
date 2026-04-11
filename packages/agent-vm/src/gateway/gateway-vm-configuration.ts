import fsSync from 'node:fs';
import path from 'node:path';

import type { SecretResolver, SecretSpec } from 'gondolin-core';

import type { SystemConfig } from '../controller/system-config.js';
import type { GatewayManagedVmFactoryOptions, GatewayZone } from './gateway-zone-support.js';

function splitResolvedGatewaySecrets(
	zone: GatewayZone,
	resolvedSecrets: Record<string, string>,
): {
	readonly envSecrets: Record<string, string>;
	readonly mediationSecrets: Record<string, SecretSpec>;
} {
	const envSecrets: Record<string, string> = {};
	const mediationSecrets: Record<string, SecretSpec> = {};

	for (const [secretName, secretValue] of Object.entries(resolvedSecrets)) {
		const secretConfig = zone.secrets[secretName];
		if (!secretConfig) {
			continue;
		}

		if (secretConfig.injection === 'http-mediation' && secretConfig.hosts) {
			mediationSecrets[secretName] = {
				hosts: [...secretConfig.hosts],
				value: secretValue,
			};
			continue;
		}

		envSecrets[secretName] = secretValue;
	}

	return { envSecrets, mediationSecrets };
}

function buildGatewayTcpHosts(
	zone: GatewayZone,
	controllerPort: number,
	tcpPool: SystemConfig['tcpPool'],
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

export async function prepareGatewayHostDirectories(options: {
	readonly secretResolver: SecretResolver;
	readonly zone: GatewayZone;
}): Promise<void> {
	fsSync.mkdirSync(options.zone.gateway.stateDir, { recursive: true });
	fsSync.mkdirSync(options.zone.gateway.workspaceDir, { recursive: true });

	if (!options.zone.gateway.authProfilesRef) {
		return;
	}

	const authProfilesDirectory = path.join(options.zone.gateway.stateDir, 'agents', 'main', 'agent');
	fsSync.mkdirSync(authProfilesDirectory, { recursive: true });
	fsSync.writeFileSync(
		path.join(authProfilesDirectory, 'auth-profiles.json'),
		await options.secretResolver.resolve({
			source: '1password',
			ref: options.zone.gateway.authProfilesRef,
		}),
		'utf8',
	);
}

export function buildGatewayVmFactoryOptions(options: {
	readonly controllerPort: number;
	readonly gatewayImagePath: string;
	readonly resolvedSecrets: Record<string, string>;
	readonly systemConfig: SystemConfig;
	readonly zone: GatewayZone;
}): GatewayManagedVmFactoryOptions {
	const configDirectory = path.dirname(path.resolve(options.zone.gateway.openclawConfig));
	const configFileName = path.basename(options.zone.gateway.openclawConfig);
	const { envSecrets, mediationSecrets } = splitResolvedGatewaySecrets(
		options.zone,
		options.resolvedSecrets,
	);

	return {
		allowedHosts: options.zone.allowedHosts,
		cpus: options.zone.gateway.cpus,
		env: {
			HOME: '/home/openclaw',
			NODE_EXTRA_CA_CERTS: '/run/gondolin/ca-certificates.crt',
			OPENCLAW_CONFIG_PATH: `/home/openclaw/.openclaw/config/${configFileName}`,
			OPENCLAW_HOME: '/home/openclaw',
			OPENCLAW_STATE_DIR: '/home/openclaw/.openclaw/state',
			...envSecrets,
		},
		imagePath: options.gatewayImagePath,
		memory: options.zone.gateway.memory,
		rootfsMode: 'cow',
		secrets: mediationSecrets,
		sessionLabel: `${options.zone.id}-gateway`,
		tcpHosts: buildGatewayTcpHosts(
			options.zone,
			options.controllerPort,
			options.systemConfig.tcpPool,
		),
		vfsMounts: {
			'/home/openclaw/.openclaw/config': {
				hostPath: configDirectory,
				kind: 'realfs',
			},
			'/home/openclaw/.openclaw/state': {
				hostPath: options.zone.gateway.stateDir,
				kind: 'realfs',
			},
			'/home/openclaw/workspace': {
				hostPath: options.zone.gateway.workspaceDir,
				kind: 'realfs',
			},
		},
	};
}
