import fs from 'node:fs/promises';

import {
	buildImage as buildImageFromCore,
	createManagedVm as createManagedVmFromCore,
	type BuildImageOptions,
	type BuildImageResult,
	type ManagedVm,
	type SecretResolver,
	type SecretSpec,
} from 'gondolin-core';

import { resolveZoneSecrets } from './credential-manager.js';
import type { SystemConfig } from './system-config.js';

type GatewayZone = SystemConfig['zones'][number];

interface GatewayBuildImageOptions {
	readonly buildConfig: unknown;
	readonly cacheDir: string;
	readonly fullReset?: boolean;
}

export interface GatewayManagerDependencies {
	readonly buildImage?: (options: GatewayBuildImageOptions) => Promise<BuildImageResult>;
	readonly createManagedVm?: (options: {
		readonly allowedHosts: readonly string[];
		readonly cpus: number;
		readonly env?: Record<string, string>;
		readonly imagePath: string;
		readonly memory: string;
		readonly rootfsMode: 'readonly' | 'memory' | 'cow';
		readonly secrets: Record<string, SecretSpec>;
		readonly sessionLabel?: string;
		readonly tcpHosts?: Record<string, string>;
		readonly vfsMounts: Record<
			string,
			{
				readonly kind: 'realfs' | 'realfs-readonly' | 'memory' | 'shadow';
				readonly hostPath?: string;
				readonly shadowConfig?: {
					readonly deny: readonly string[];
					readonly tmpfs: readonly string[];
				};
			}
		>;
	}) => Promise<ManagedVm>;
	readonly loadBuildConfig?: (buildConfigPath: string) => Promise<unknown>;
}

function findZone(systemConfig: SystemConfig, zoneId: string): GatewayZone {
	const zone = systemConfig.zones.find((candidateZone) => candidateZone.id === zoneId);
	if (!zone) {
		throw new Error(`Unknown zone '${zoneId}'.`);
	}

	return zone;
}

// Secrets that can be injected at the HTTP boundary (API keys in headers)
function resolveSecretHosts(secretName: string): readonly string[] {
	switch (secretName) {
		case 'ANTHROPIC_API_KEY':
			return ['api.anthropic.com'];
		case 'OPENAI_API_KEY':
			return ['api.openai.com'];
		case 'GITHUB_PAT':
			return ['api.github.com'];
		default:
			return [];
	}
}

// Secrets that must be real env vars inside the VM (used by client libraries
// in WebSocket payloads or other non-HTTP-header auth flows)
const ENV_ONLY_SECRETS = new Set(['DISCORD_BOT_TOKEN']);

async function loadJsonFile(filePath: string): Promise<unknown> {
	const rawContents = await fs.readFile(filePath, 'utf8');
	return JSON.parse(rawContents);
}

export async function startGatewayZone(
	options: {
		readonly pluginSourceDir?: string;
		readonly systemConfig: SystemConfig;
		readonly zoneId: string;
		readonly secretResolver: SecretResolver;
	},
	dependencies: GatewayManagerDependencies = {},
): Promise<{
	readonly image: BuildImageResult;
	readonly ingress: {
		readonly host: string;
		readonly port: number;
	};
	readonly vm: ManagedVm;
	readonly zone: GatewayZone;
}> {
	const zone = findZone(options.systemConfig, options.zoneId);
	const resolvedSecrets = await resolveZoneSecrets({
		systemConfig: options.systemConfig,
		zoneId: zone.id,
		secretResolver: options.secretResolver,
	});
	const loadBuildConfig = dependencies.loadBuildConfig ?? loadJsonFile;
	const buildImage =
		dependencies.buildImage ??
		(async (buildOptions: GatewayBuildImageOptions): Promise<BuildImageResult> => {
			const coreBuildOptions: BuildImageOptions = {
				buildConfig: buildOptions.buildConfig as never,
				cacheDir: buildOptions.cacheDir,
				...(buildOptions.fullReset !== undefined ? { fullReset: buildOptions.fullReset } : {}),
			};

			return await buildImageFromCore(coreBuildOptions);
		});
	const createManagedVm = dependencies.createManagedVm ?? createManagedVmFromCore;
	const buildConfig = await loadBuildConfig(options.systemConfig.images.gateway.buildConfig);
	const image = await buildImage({
		buildConfig,
		cacheDir: `${zone.gateway.stateDir}/images/gateway`,
	});
	// Split secrets: env-only secrets go as real env vars (e.g. DISCORD_BOT_TOKEN
	// is sent inside a WebSocket payload by discord.js, not in HTTP headers).
	// HTTP-mediation secrets get placeholder injection at the network boundary.
	const envOnlySecrets: Record<string, string> = {};
	const mediationSecrets: Record<string, SecretSpec> = {};
	for (const [secretName, secretValue] of Object.entries(resolvedSecrets)) {
		if (ENV_ONLY_SECRETS.has(secretName)) {
			envOnlySecrets[secretName] = secretValue;
		} else {
			const hosts = resolveSecretHosts(secretName);
			if (hosts.length > 0) {
				mediationSecrets[secretName] = { hosts: [...hosts], value: secretValue };
			}
		}
	}

	const managedVm = await createManagedVm({
		allowedHosts: zone.allowedHosts,
		cpus: zone.gateway.cpus,
		env: {
			HOME: '/home/openclaw',
			NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt',
			OPENCLAW_CONFIG_PATH: '/home/openclaw/.openclaw/openclaw.json',
			OPENCLAW_STATE_DIR: '/home/openclaw/.openclaw/state',
			...envOnlySecrets,
		},
		imagePath: image.imagePath,
		memory: zone.gateway.memory,
		rootfsMode: 'cow',
		secrets: mediationSecrets,
		sessionLabel: `${zone.id}-gateway`,
		tcpHosts: {
			'controller.vm.host:18800': `127.0.0.1:${options.systemConfig.host.controllerPort}`,
			// Discord WebSocket bypass: discord.js uses the ws library which is
			// unreliable through Gondolin's HTTP MITM proxy. Raw TCP tunnel works.
			'gateway.discord.gg:443': 'gateway.discord.gg:443',
		},
		vfsMounts: {
			'/home/openclaw/.openclaw/openclaw.json': {
				hostPath: zone.gateway.openclawConfig,
				kind: 'realfs-readonly',
			},
			'/home/openclaw/.openclaw/state': {
				hostPath: zone.gateway.stateDir,
				kind: 'realfs',
			},
			'/home/openclaw/workspace': {
				hostPath: zone.gateway.workspaceDir,
				kind: 'realfs',
			},
			...(options.pluginSourceDir
				? {
						'/home/openclaw/.openclaw/extensions/gondolin': {
							hostPath: options.pluginSourceDir,
							kind: 'realfs-readonly' as const,
						},
					}
				: {}),
		},
	});

	// Start OpenClaw gateway backgrounded with output redirected so exec() returns immediately.
	await managedVm.exec(
		'cd /home/openclaw && nohup openclaw gateway --port 18789 > /tmp/openclaw.log 2>&1 &',
	);

	// Poll for readiness (OpenClaw needs ~2-3s to bind the port).
	// Accept any HTTP status (including 401) as "listening" — use curl to get the status code.
	const maxAttempts = 30;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const check = await managedVm.exec(
			'curl -sS -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:18789/ 2>/dev/null || echo 000',
		);
		const httpCode = check.stdout.trim();
		if (httpCode !== '000') {
			break;
		}

		// oxlint-disable-next-line eslint/no-await-in-loop -- sequential polling for port readiness
		await new Promise((resolve) => setTimeout(resolve, 500));
	}

	// Configure and enable ingress now that OpenClaw is ready
	managedVm.setIngressRoutes([
		{
			port: 18789,
			prefix: '/',
			stripPrefix: true,
		},
	]);
	const ingress = await managedVm.enableIngress({
		listenPort: zone.gateway.port,
	});

	return {
		image,
		ingress,
		vm: managedVm,
		zone,
	};
}
