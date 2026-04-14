import fs from 'node:fs/promises';
import path from 'node:path';

import type {
	GatewayLifecycle,
	GatewayProcessSpec,
	GatewayZoneConfig,
	GatewayVmSpec,
} from '@shravansunder/gateway-interface';
import { splitResolvedGatewaySecrets } from '@shravansunder/gateway-interface';
import type { SecretResolver } from '@shravansunder/gondolin-core';

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
	zone: GatewayZoneConfig,
	resolvedSecrets: Record<string, string>,
): string {
	const environmentLines = [
		'export OPENCLAW_HOME=/home/openclaw',
		`export OPENCLAW_CONFIG_PATH=/home/openclaw/.openclaw/config/${path.basename(zone.gateway.gatewayConfig)}`,
		'export OPENCLAW_STATE_DIR=/home/openclaw/.openclaw/state',
		'export NODE_EXTRA_CA_CERTS=/run/gondolin/ca-certificates.crt',
	];
	const gatewayToken = resolvedSecrets.OPENCLAW_GATEWAY_TOKEN;
	if (gatewayToken) {
		environmentLines.push(
			`export OPENCLAW_GATEWAY_TOKEN='${gatewayToken.replace(/'/gu, "'\\''")}'`,
		);
	}

	return (
		'mkdir -p /root && cat > /root/.openclaw-env << ENVEOF\n' +
		environmentLines.join('\n') +
		'\nENVEOF\n' +
		'chmod 600 /root/.openclaw-env && ' +
		'touch /root/.bashrc && ' +
		"grep -qxF 'source /root/.openclaw-env' /root/.bashrc || echo 'source /root/.openclaw-env' >> /root/.bashrc"
	);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export const openclawLifecycle: GatewayLifecycle = {
	authConfig: {
		listProvidersCommand: 'openclaw models auth list --format plain 2>/dev/null || echo ""',
		buildLoginCommand: (provider: string): string =>
			`openclaw models auth login --provider ${shellQuote(provider)}`,
	},

	buildVmSpec(
		zone: GatewayZoneConfig,
		resolvedSecrets: Record<string, string>,
		controllerPort: number,
		tcpPool: { readonly basePort: number; readonly size: number },
	): GatewayVmSpec {
		const configDirectory = path.dirname(path.resolve(zone.gateway.gatewayConfig));
		const configFileName = path.basename(zone.gateway.gatewayConfig);
		const { environmentSecrets, mediatedSecrets } = splitResolvedGatewaySecrets(
			zone,
			resolvedSecrets,
		);

		return {
			allowedHosts: [...zone.allowedHosts],
			environment: {
				HOME: '/home/openclaw',
				NODE_EXTRA_CA_CERTS: '/run/gondolin/ca-certificates.crt',
				OPENCLAW_CONFIG_PATH: `/home/openclaw/.openclaw/config/${configFileName}`,
				OPENCLAW_HOME: '/home/openclaw',
				OPENCLAW_STATE_DIR: '/home/openclaw/.openclaw/state',
				...environmentSecrets,
			},
			mediatedSecrets,
			rootfsMode: 'cow',
			sessionLabel: `${zone.id}-gateway`,
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
		if (!zone.gateway.authProfilesRef) {
			return;
		}

		const authProfilesDirectory = path.join(zone.gateway.stateDir, 'agents', 'main', 'agent');
		await fs.mkdir(authProfilesDirectory, { recursive: true });
		const authProfilesRef =
			zone.gateway.authProfilesRef.source === 'environment'
				? {
						source: 'environment' as const,
						ref: zone.gateway.authProfilesRef.envVar,
					}
				: zone.gateway.authProfilesRef;
		await fs.writeFile(
			path.join(authProfilesDirectory, 'auth-profiles.json'),
			await secretResolver.resolve(authProfilesRef),
			'utf8',
		);
	},
};
