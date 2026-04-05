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

function resolveSecretHosts(secretName: string): readonly string[] {
	switch (secretName) {
		case 'ANTHROPIC_API_KEY':
			return ['api.anthropic.com'];
		case 'OPENAI_API_KEY':
			return ['api.openai.com'];
		case 'GITHUB_PAT':
			return ['api.github.com'];
		case 'DISCORD_BOT_TOKEN':
			return ['discord.com', 'gateway.discord.gg'];
		default:
			return [];
	}
}

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
	const managedVm = await createManagedVm({
		allowedHosts: zone.allowedHosts,
		cpus: zone.gateway.cpus,
		imagePath: image.imagePath,
		memory: zone.gateway.memory,
		rootfsMode: 'memory',
		secrets: Object.fromEntries(
			Object.entries(resolvedSecrets).map(([secretName, secretValue]) => [
				secretName,
				{
					hosts: resolveSecretHosts(secretName),
					value: secretValue,
				},
			]),
		),
		sessionLabel: `${zone.id}-gateway`,
		tcpHosts: {
			'controller.vm.host:18800': `127.0.0.1:${options.systemConfig.host.controllerPort}`,
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

	await managedVm.exec('openclaw gateway --port 18789 &');
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
