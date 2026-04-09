import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

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

async function loadJsonFile(filePath: string): Promise<unknown> {
	const rawContents = await fs.readFile(filePath, 'utf8');
	return JSON.parse(rawContents);
}

/**
 * Split resolved secrets into env vars and HTTP mediation based on
 * the injection type configured in system.json per secret.
 */
function splitSecretsByInjection(
	zone: GatewayZone,
	resolvedSecrets: Record<string, string>,
): {
	envSecrets: Record<string, string>;
	mediationSecrets: Record<string, SecretSpec>;
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
		} else {
			// Default: env var injection
			envSecrets[secretName] = secretValue;
		}
	}

	return { envSecrets, mediationSecrets };
}

/**
 * Build tcp.hosts map from zone config:
 * - Controller back-channel
 * - WebSocket bypass entries (Discord, WhatsApp)
 * - Tool VM SSH slots from TCP pool
 */
function buildTcpHosts(
	zone: GatewayZone,
	controllerPort: number,
	tcpPool: { readonly basePort: number; readonly size: number },
): Record<string, string> {
	const tcpHosts: Record<string, string> = {
		'controller.vm.host:18800': `127.0.0.1:${controllerPort}`,
	};

	// Tool VM SSH slots: map tool-N.vm.host:22 → 127.0.0.1:<basePort+N>
	// so the gateway VM can SSH into leased tool VMs via tcp.hosts tunnel
	for (let slot = 0; slot < tcpPool.size; slot++) {
		tcpHosts[`tool-${slot}.vm.host:22`] = `127.0.0.1:${tcpPool.basePort + slot}`;
	}

	// WebSocket bypass: raw TCP tunnel for channels that use ws library
	// (Discord, WhatsApp) — bypasses Gondolin HTTP MITM proxy
	for (const wsHost of zone.websocketBypass) {
		tcpHosts[wsHost] = wsHost;
	}

	return tcpHosts;
}

async function waitForGatewayReadiness(managedVm: ManagedVm, attempt: number, maxAttempts: number): Promise<void> {
	if (attempt >= maxAttempts) {
		return;
	}

	const check = await managedVm.exec(
		'curl -sS -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:18789/ 2>/dev/null || echo 000',
	);
	if (check.stdout.trim() !== '000') {
		return;
	}

	await new Promise((resolve) => setTimeout(resolve, 500));
	await waitForGatewayReadiness(managedVm, attempt + 1, maxAttempts);
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

	// Ensure host directories exist before mounting into the VM
	fsSync.mkdirSync(zone.gateway.stateDir, { recursive: true });
	fsSync.mkdirSync(zone.gateway.workspaceDir, { recursive: true });

	// Restore auth-profiles from 1P into the state dir before VM boot.
	// OpenClaw reads auth-profiles.json at startup from $OPENCLAW_STATE_DIR/agents/main/agent/.
	// The state dir is VFS-mounted, so writing on the host makes it visible inside the VM.
	if (zone.gateway.authProfilesRef) {
		const authProfilesDir = path.join(zone.gateway.stateDir, 'agents', 'main', 'agent');
		fsSync.mkdirSync(authProfilesDir, { recursive: true });
		const authProfilesJson = await options.secretResolver.resolve({
			source: '1password',
			ref: zone.gateway.authProfilesRef,
		});
		fsSync.writeFileSync(
			path.join(authProfilesDir, 'auth-profiles.json'),
			authProfilesJson,
			'utf8',
		);
	}

	// Split secrets by injection type (from system.json config)
	const { envSecrets, mediationSecrets } = splitSecretsByInjection(zone, resolvedSecrets);

	// Resolve config dir from the config file path (mount the directory, not the file)
	const configDir = path.dirname(path.resolve(zone.gateway.openclawConfig));
	const configFileName = path.basename(zone.gateway.openclawConfig);

	const managedVm = await createManagedVm({
		allowedHosts: zone.allowedHosts,
		cpus: zone.gateway.cpus,
		env: {
			HOME: '/home/openclaw',
			NODE_EXTRA_CA_CERTS: '/run/gondolin/ca-certificates.crt',
			OPENCLAW_HOME: '/home/openclaw',
			OPENCLAW_CONFIG_PATH: `/home/openclaw/.openclaw/config/${configFileName}`,
			OPENCLAW_STATE_DIR: '/home/openclaw/.openclaw/state',
			...envSecrets,
		},
		imagePath: image.imagePath,
		memory: zone.gateway.memory,
		rootfsMode: 'cow',
		secrets: mediationSecrets,
		sessionLabel: `${zone.id}-gateway`,
		tcpHosts: buildTcpHosts(zone, options.systemConfig.host.controllerPort, options.systemConfig.tcpPool),
		vfsMounts: {
			'/home/openclaw/.openclaw/config': {
				hostPath: configDir,
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
			...(options.pluginSourceDir
				? {
						'/opt/gondolin-plugin-src': {
							hostPath: options.pluginSourceDir,
							kind: 'realfs-readonly' as const,
						},
					}
				: {}),
		},
	});

	// Update Gondolin CA trust in the Debian image.
	// Gondolin injects its MITM CA at /usr/local/share/ca-certificates/gondolin-mitm-ca.crt.
	// update-ca-certificates merges it into the system trust store so npm/curl work.
	await managedVm.exec('update-ca-certificates > /dev/null 2>&1');

	// Write OpenClaw env vars to /etc/profile.d/ so SSH sessions inherit them.
	// Debian sources /etc/profile.d/*.sh on login shell init (bash).
	// Also write to /root/.bashrc as a fallback for non-login SSH sessions.
	const envVarsScript =
		'export OPENCLAW_HOME=/home/openclaw\n' +
		`export OPENCLAW_CONFIG_PATH=/home/openclaw/.openclaw/config/${configFileName}\n` +
		'export OPENCLAW_STATE_DIR=/home/openclaw/.openclaw/state\n' +
		'export OPENCLAW_GATEWAY_TOKEN=$OPENCLAW_GATEWAY_TOKEN\n' +
		'export NODE_EXTRA_CA_CERTS=/run/gondolin/ca-certificates.crt\n';

	await managedVm.exec(
		'mkdir -p /etc/profile.d && cat > /etc/profile.d/openclaw.sh << ENVEOF\n' +
		envVarsScript +
		'ENVEOF\n' +
		'chmod 644 /etc/profile.d/openclaw.sh && ' +
		'cat /etc/profile.d/openclaw.sh >> /root/.bashrc',
	);

	// Copy plugin into OpenClaw's built-in extensions directory.
	// This preserves all built-in providers (openai-codex, etc.) while adding ours.
	// OpenClaw rejects plugins owned by non-root UIDs (VFS preserves host UID).
	if (options.pluginSourceDir) {
		const openclawExtensionsDir = '/usr/local/lib/node_modules/openclaw/dist/extensions';
		await managedVm.exec(
			`mkdir -p ${openclawExtensionsDir}/gondolin && ` +
			`cp -a /opt/gondolin-plugin-src/. ${openclawExtensionsDir}/gondolin/ && ` +
			`chown -R root:root ${openclawExtensionsDir}/gondolin`,
		);
	}

	// Start OpenClaw gateway backgrounded with output redirected so exec() returns immediately.
	await managedVm.exec(
		'cd /home/openclaw && nohup openclaw gateway --port 18789 > /tmp/openclaw.log 2>&1 &',
	);

	// Poll for readiness (OpenClaw needs ~2-3s to bind the port).
	// Accept any HTTP status (including 401) as "listening" — use curl to get the status code.
	await waitForGatewayReadiness(managedVm, 0, 30);

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
