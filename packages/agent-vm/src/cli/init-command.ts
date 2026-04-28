import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';

import {
	DEFAULT_COMMON_AGENT_INSTRUCTIONS,
	DEFAULT_PLAN_AGENT_INSTRUCTIONS,
	DEFAULT_PLAN_REVIEWER_INSTRUCTIONS,
	DEFAULT_WORK_AGENT_INSTRUCTIONS,
	DEFAULT_WORK_REVIEWER_INSTRUCTIONS,
	DEFAULT_WRAPUP_INSTRUCTIONS,
} from '@agent-vm/agent-vm-worker';
import type { GatewayType } from '@agent-vm/gateway-interface';
import {
	resolveGondolinMinimumZigVersion,
	resolveGondolinPackageSpec,
} from '@agent-vm/gondolin-adapter';
import { z } from 'zod';

import { resolveConfigPath } from '../config/path-resolver.js';
import {
	SYSTEM_CACHE_IDENTIFIER_FILENAME,
	buildDefaultSystemCacheIdentifier,
	type HostSystemType,
} from '../config/system-cache-identifier.js';
import { buildDefaultProjectNamespace } from '../runtime/project-namespace.js';
import {
	getKeychainTokenSource,
	hasServiceAccountToken,
	storeServiceAccountToken,
} from './keychain-credential.js';
import {
	openClawPluginVendorDirectory,
	syncBundledOpenClawPluginBundle,
} from './openclaw-plugin-bundle.js';
import {
	renderVmHostSystemDockerfile,
	renderVmHostSystemReadme,
	renderVmHostSystemStartScript,
	renderVmHostSystemSystemdUnit,
} from './vm-host-system-templates.js';

export const secretsProviderSchema = z.enum(['1password', 'environment']);
export type SecretsProvider = z.infer<typeof secretsProviderSchema>;
export const imageArchitectureSchema = z.enum(['aarch64', 'x86_64']);
export type ImageArchitecture = z.infer<typeof imageArchitectureSchema>;

export interface ScaffoldAgentVmProjectOptions {
	readonly architecture: ImageArchitecture;
	readonly gatewayType: GatewayType;
	readonly hostSystemType?: HostSystemType;
	readonly secretsProvider: SecretsProvider;
	readonly paths?: ScaffoldPathMode;
	readonly projectNamespace?: string;
	readonly targetDir: string;
	readonly overwrite?: boolean;
	readonly writeLocalEnvironmentFile?: boolean;
	readonly zoneId: string;
}

export interface ScaffoldAgentVmProjectResult {
	readonly created: readonly string[];
	readonly keychainStored: boolean;
	readonly skipped: readonly string[];
}

interface ScaffoldAgentVmProjectDependencies {
	readonly copyBundledOpenClawPlugin?: (
		targetDir: string,
		profileName: string,
	) => Promise<'created' | 'skipped'>;
	readonly getHomeDir?: () => string;
	readonly resolveGondolinMinimumZigVersion?: typeof resolveGondolinMinimumZigVersion;
}

export interface PromptAndStoreTokenDependencies {
	readonly hasKeychainToken?: () => boolean;
	readonly storeKeychainToken?: (token: string) => void;
	readonly createReadlineInterface?: () => readline.Interface;
}

export type { GatewayType } from '@agent-vm/gateway-interface';

export type ScaffoldPathMode = 'local' | 'pod' | 'user-dir';

interface ScaffoldPathProfile {
	readonly cacheDir: string;
	readonly runtimeDir: string;
	readonly createLocalRuntimeDirectories: boolean;
	readonly gatewayConfig: (zoneId: string, gatewayType: GatewayType) => string;
	readonly gatewayStateDir: (zoneId: string) => string;
	readonly gatewayZoneFilesDir: (zoneId: string) => string;
	readonly gatewayBackupDir: (zoneId: string) => string;
	readonly gatewayBuildConfig: (gatewayType: GatewayType) => string;
	readonly gatewayDockerfile: (gatewayType: GatewayType) => string;
	readonly toolVmBuildConfig: string;
	readonly toolVmDockerfile: string;
	readonly toolWorkspaceRoot: string;
}

interface PromptReference {
	readonly path: string;
}

interface ScaffoldMcpServer {
	readonly name: string;
	readonly url: string;
	readonly bearerTokenEnvVar?: string;
}

interface ScaffoldWorkerGatewayConfig {
	readonly commonAgentInstructions: PromptReference;
	readonly defaults: {
		readonly provider: string;
		readonly model: string;
	};
	readonly phases: {
		readonly plan: {
			readonly cycle: { readonly kind: 'review'; readonly cycleCount: number };
			readonly agentInstructions: PromptReference;
			readonly reviewerInstructions: PromptReference;
			readonly agentTurnTimeoutMs: number;
			readonly reviewerTurnTimeoutMs: number;
			readonly skills: readonly [];
		};
		readonly work: {
			readonly cycle: { readonly kind: 'review'; readonly cycleCount: number };
			readonly agentInstructions: PromptReference;
			readonly reviewerInstructions: PromptReference;
			readonly agentTurnTimeoutMs: number;
			readonly reviewerTurnTimeoutMs: number;
			readonly skills: readonly [];
		};
		readonly wrapup: {
			readonly instructions: PromptReference;
			readonly turnTimeoutMs: number;
			readonly skills: readonly [];
		};
	};
	readonly mcpServers: readonly ScaffoldMcpServer[];
	readonly verification: readonly [];
	readonly verificationTimeoutMs: number;
	readonly branchPrefix: string;
	readonly stateDir: string;
}

interface RuntimeAuthHint {
	readonly kind: 'service-token';
	readonly secret: string;
	readonly service: string;
	readonly hosts: readonly string[];
	readonly tools: readonly string[];
}

const defaultGatewayIngressPort = 18791;
const defaultOpenClawExtensionsPath = '/home/openclaw/.openclaw/extensions';
const scaffoldedGatewayPortSystemConfigSchema = z
	.object({
		zones: z.array(
			z.object({
				id: z.string().min(1),
				gateway: z.object({
					port: z.number().int().positive(),
				}),
			}),
		),
	})
	.passthrough();

function resolveGatewayConfigFileName(gatewayType: GatewayType): 'worker.json' | 'openclaw.json' {
	return gatewayType === 'worker' ? 'worker.json' : 'openclaw.json';
}

const localPathProfile: ScaffoldPathProfile = {
	cacheDir: '../cache',
	runtimeDir: '../runtime',
	createLocalRuntimeDirectories: true,
	gatewayConfig: (zoneId, gatewayType) =>
		`./gateways/${zoneId}/${resolveGatewayConfigFileName(gatewayType)}`,
	gatewayStateDir: (zoneId) => `../state/${zoneId}`,
	gatewayZoneFilesDir: (zoneId) => `../zone-files/${zoneId}`,
	gatewayBackupDir: (zoneId) => `../backups/${zoneId}`,
	gatewayBuildConfig: (gatewayType) => `../vm-images/gateways/${gatewayType}/build-config.json`,
	gatewayDockerfile: (gatewayType) => `../vm-images/gateways/${gatewayType}/Dockerfile`,
	toolVmBuildConfig: '../vm-images/tool-vms/default/build-config.json',
	toolVmDockerfile: '../vm-images/tool-vms/default/Dockerfile',
	toolWorkspaceRoot: '../workspaces/tools',
};

const podPathProfile: ScaffoldPathProfile = {
	cacheDir: '/var/agent-vm/cache',
	runtimeDir: '/var/agent-vm/runtime',
	createLocalRuntimeDirectories: false,
	gatewayConfig: (zoneId, gatewayType) =>
		`/etc/agent-vm/gateways/${zoneId}/${resolveGatewayConfigFileName(gatewayType)}`,
	gatewayStateDir: () => '/var/agent-vm/state',
	gatewayZoneFilesDir: () => '/var/agent-vm/zone-files',
	gatewayBackupDir: () => '/var/agent-vm/backups',
	gatewayBuildConfig: (gatewayType) =>
		`/etc/agent-vm/vm-images/gateways/${gatewayType}/build-config.json`,
	gatewayDockerfile: (gatewayType) => `/etc/agent-vm/vm-images/gateways/${gatewayType}/Dockerfile`,
	toolVmBuildConfig: '/etc/agent-vm/vm-images/tool-vms/default/build-config.json',
	toolVmDockerfile: '/etc/agent-vm/vm-images/tool-vms/default/Dockerfile',
	toolWorkspaceRoot: '/var/agent-vm/workspace/tools',
};

/**
 * User-home profile: runtime state in ~/.agent-vm/, backups in
 * ~/.agent-vm-backups/ so a wipe of the runtime tree can't take
 * its own recovery archive with it.  Catalog files (gateway
 * config, image recipes) stay in-repo.
 */
const userDirPathProfile: ScaffoldPathProfile = {
	cacheDir: '~/.agent-vm/cache',
	runtimeDir: '~/.agent-vm/runtime',
	createLocalRuntimeDirectories: true,
	gatewayConfig: (zoneId, gatewayType) =>
		`./gateways/${zoneId}/${resolveGatewayConfigFileName(gatewayType)}`,
	gatewayStateDir: (zoneId) => `~/.agent-vm/state/${zoneId}`,
	gatewayZoneFilesDir: (zoneId) => `~/.agent-vm/zone-files/${zoneId}`,
	gatewayBackupDir: (zoneId) => `~/.agent-vm-backups/${zoneId}`,
	gatewayBuildConfig: (gatewayType) => `../vm-images/gateways/${gatewayType}/build-config.json`,
	gatewayDockerfile: (gatewayType) => `../vm-images/gateways/${gatewayType}/Dockerfile`,
	toolVmBuildConfig: '../vm-images/tool-vms/default/build-config.json',
	toolVmDockerfile: '../vm-images/tool-vms/default/Dockerfile',
	toolWorkspaceRoot: '~/.agent-vm/workspaces/tools',
};

function resolveScaffoldPathProfile(paths: ScaffoldPathMode | undefined): ScaffoldPathProfile {
	switch (paths) {
		case 'pod':
			return podPathProfile;
		case 'user-dir':
			return userDirPathProfile;
		case 'local':
		case undefined:
			return localPathProfile;
		default:
			return localPathProfile;
	}
}

function resolveHomeRelativeScaffoldPath(
	profilePath: string,
	configDir: string,
	homeDir: string | undefined,
): string {
	if (profilePath === '~' || profilePath.startsWith('~/')) {
		return resolveConfigPath(profilePath, configDir, homeDir);
	}
	return profilePath;
}

function resolveConfigWritablePathProfile(
	pathProfile: ScaffoldPathProfile,
	configDir: string,
	homeDir: string | undefined,
): ScaffoldPathProfile {
	return {
		...pathProfile,
		cacheDir: resolveHomeRelativeScaffoldPath(pathProfile.cacheDir, configDir, homeDir),
		runtimeDir: resolveHomeRelativeScaffoldPath(pathProfile.runtimeDir, configDir, homeDir),
		gatewayStateDir: (zoneId) =>
			resolveHomeRelativeScaffoldPath(pathProfile.gatewayStateDir(zoneId), configDir, homeDir),
		gatewayZoneFilesDir: (zoneId) =>
			resolveHomeRelativeScaffoldPath(pathProfile.gatewayZoneFilesDir(zoneId), configDir, homeDir),
		gatewayBackupDir: (zoneId) =>
			resolveHomeRelativeScaffoldPath(pathProfile.gatewayBackupDir(zoneId), configDir, homeDir),
		toolVmDockerfile: resolveHomeRelativeScaffoldPath(
			pathProfile.toolVmDockerfile,
			configDir,
			homeDir,
		),
		toolWorkspaceRoot: resolveHomeRelativeScaffoldPath(
			pathProfile.toolWorkspaceRoot,
			configDir,
			homeDir,
		),
	};
}

function defaultToolVmImageProfiles(
	gatewayType: GatewayType,
	pathProfile: ScaffoldPathProfile,
): Record<
	string,
	{ readonly type: 'toolVm'; readonly buildConfig: string; readonly dockerfile: string }
> {
	if (gatewayType !== 'openclaw') {
		return {};
	}
	return {
		default: {
			type: 'toolVm',
			buildConfig: pathProfile.toolVmBuildConfig,
			dockerfile: pathProfile.toolVmDockerfile,
		},
	};
}

function defaultToolProfiles(
	gatewayType: GatewayType,
	pathProfile: ScaffoldPathProfile,
): Record<
	string,
	{
		readonly memory: string;
		readonly cpus: number;
		readonly workspaceRoot: string;
		readonly imageProfile: string;
	}
> {
	if (gatewayType !== 'openclaw') {
		return {};
	}
	return {
		standard: {
			memory: '1G',
			cpus: 1,
			workspaceRoot: pathProfile.toolWorkspaceRoot,
			imageProfile: 'default',
		},
	};
}

const defaultSystemConfig = (
	zoneId: string,
	gatewayType: GatewayType,
	projectNamespace: string,
	secretsProvider: SecretsProvider,
	pathProfile: ScaffoldPathProfile,
): object => ({
	host: {
		controllerPort: 18800,
		projectNamespace,
		githubToken: defaultHostGithubToken(secretsProvider),
		...(secretsProvider === '1password'
			? {
					secretsProvider: {
						type: '1password',
						tokenSource: getKeychainTokenSource(),
					},
				}
			: {}),
	},
	cacheDir: pathProfile.cacheDir,
	runtimeDir: pathProfile.runtimeDir,
	imageProfiles: {
		gateways: {
			[gatewayType]: {
				type: gatewayType,
				buildConfig: pathProfile.gatewayBuildConfig(gatewayType),
				dockerfile: pathProfile.gatewayDockerfile(gatewayType),
			},
		},
		toolVms: defaultToolVmImageProfiles(gatewayType, pathProfile),
	},
	zones: [
		{
			id: zoneId,
			gateway: {
				type: gatewayType,
				memory: '2G',
				cpus: 2,
				port: defaultGatewayIngressPort,
				config: pathProfile.gatewayConfig(zoneId, gatewayType),
				imageProfile: gatewayType,
				stateDir: pathProfile.gatewayStateDir(zoneId),
				...(gatewayType === 'openclaw'
					? { zoneFilesDir: pathProfile.gatewayZoneFilesDir(zoneId) }
					: {}),
				backupDir: pathProfile.gatewayBackupDir(zoneId),
			},
			secrets: defaultSecretsForGatewayType(zoneId, gatewayType, secretsProvider),
			runtimeAuthHints: defaultRuntimeAuthHintsForGatewayType(gatewayType),
			allowedHosts: defaultAllowedHostsForGatewayType(gatewayType),
			websocketBypass: defaultWebsocketBypassForGatewayType(gatewayType),
			...(gatewayType === 'openclaw' ? { toolProfile: 'standard' } : {}),
		},
	],
	toolProfiles: defaultToolProfiles(gatewayType, pathProfile),
	tcpPool: {
		basePort: 19000,
		size: 5,
	},
});

type SecretInjection = 'env' | 'http-mediation';

type HostGithubToken =
	| { readonly source: '1password'; readonly ref: string }
	| { readonly source: 'environment'; readonly envVar: string };

type SecretReference =
	| {
			readonly source: '1password';
			readonly ref: string;
			readonly injection: SecretInjection;
			readonly hosts?: readonly string[];
	  }
	| {
			readonly source: 'environment';
			readonly envVar: string;
			readonly injection: SecretInjection;
			readonly hosts?: readonly string[];
	  };

function assertNeverSecretsProvider(value: never): never {
	throw new Error(`Unhandled secrets provider: ${String(value)}`);
}

function defaultHostGithubToken(secretsProvider: SecretsProvider): HostGithubToken {
	switch (secretsProvider) {
		case '1password':
			return { source: '1password', ref: 'op://agent-vm/github-token/credential' };
		case 'environment':
			return { source: 'environment', envVar: 'GITHUB_TOKEN' };
		default:
			return assertNeverSecretsProvider(secretsProvider);
	}
}

interface SecretShape {
	readonly envVar: string;
	readonly opRef: string;
	readonly injection: SecretInjection;
	readonly hosts?: readonly string[];
}

function secretFromShape(shape: SecretShape, secretsProvider: SecretsProvider): SecretReference {
	const hostsField = shape.hosts ? { hosts: shape.hosts } : {};
	switch (secretsProvider) {
		case '1password':
			return {
				source: '1password',
				ref: shape.opRef,
				injection: shape.injection,
				...hostsField,
			};
		case 'environment':
			return {
				source: 'environment',
				envVar: shape.envVar,
				injection: shape.injection,
				...hostsField,
			};
		default:
			return assertNeverSecretsProvider(secretsProvider);
	}
}

function defaultSecretsForGatewayType(
	zoneId: string,
	gatewayType: GatewayType,
	secretsProvider: SecretsProvider,
): Record<string, SecretReference> {
	if (gatewayType === 'worker') {
		return {
			GITHUB_TOKEN: secretFromShape(
				{
					envVar: 'GITHUB_TOKEN',
					opRef: 'op://agent-vm/github-token/credential',
					injection: 'http-mediation',
					hosts: ['api.github.com'],
				},
				secretsProvider,
			),
			OPENAI_API_KEY: secretFromShape(
				{
					envVar: 'OPENAI_API_KEY',
					opRef: 'op://agent-vm/workers-openai/credential',
					injection: 'http-mediation',
					hosts: ['api.openai.com'],
				},
				secretsProvider,
			),
		};
	}

	return {
		DISCORD_BOT_TOKEN: secretFromShape(
			{
				envVar: 'DISCORD_BOT_TOKEN',
				opRef: `op://agent-vm/${zoneId}-discord/bot-token`,
				injection: 'env',
			},
			secretsProvider,
		),
		PERPLEXITY_API_KEY: secretFromShape(
			{
				envVar: 'PERPLEXITY_API_KEY',
				opRef: `op://agent-vm/${zoneId}-perplexity/credential`,
				injection: 'http-mediation',
				hosts: ['api.perplexity.ai'],
			},
			secretsProvider,
		),
		OPENCLAW_GATEWAY_TOKEN: secretFromShape(
			{
				envVar: 'OPENCLAW_GATEWAY_TOKEN',
				opRef: `op://agent-vm/${zoneId}-gateway-auth/password`,
				injection: 'env',
			},
			secretsProvider,
		),
	};
}

function defaultRuntimeAuthHintsForGatewayType(
	gatewayType: GatewayType,
): readonly RuntimeAuthHint[] {
	if (gatewayType !== 'worker') {
		return [];
	}

	return [
		{
			kind: 'service-token',
			secret: 'GITHUB_TOKEN',
			service: 'github',
			hosts: ['api.github.com'],
			tools: ['gh'],
		},
	];
}

function defaultAllowedHostsForGatewayType(gatewayType: GatewayType): readonly string[] {
	if (gatewayType === 'worker') {
		return [
			'api.anthropic.com',
			'api.openai.com',
			'auth.openai.com',
			'api.github.com',
			'github.com',
			'registry.npmjs.org',
			'mcp.deepwiki.com',
		];
	}

	return [
		'api.anthropic.com',
		'api.openai.com',
		'auth.openai.com',
		'chatgpt.com',
		'generativelanguage.googleapis.com',
		'oauth2.googleapis.com',
		'accounts.google.com',
		'api.x.ai',
		'api.groq.com',
		'api.mistral.ai',
		'api.deepseek.com',
		'api.openrouter.ai',
		'openrouter.ai',
		'api.perplexity.ai',
		'api.together.xyz',
		'api.fireworks.ai',
		'api.cerebras.ai',
		'api.cohere.ai',
		'discord.com',
		'cdn.discordapp.com',
		'api.github.com',
		'registry.npmjs.org',
	];
}

function defaultWebsocketBypassForGatewayType(gatewayType: GatewayType): readonly string[] {
	if (gatewayType === 'worker') {
		return [];
	}

	return [
		'gateway.discord.gg:443',
		'web.whatsapp.com:443',
		'g.whatsapp.net:443',
		'mmg.whatsapp.net:443',
	];
}

function envVarsForGatewayType(gatewayType: GatewayType): readonly string[] {
	switch (gatewayType) {
		case 'worker':
			return ['GITHUB_TOKEN', 'OPENAI_API_KEY'];
		case 'openclaw':
			return ['GITHUB_TOKEN', 'DISCORD_BOT_TOKEN', 'PERPLEXITY_API_KEY', 'OPENCLAW_GATEWAY_TOKEN'];
		default: {
			const exhaustive: never = gatewayType;
			throw new Error(`Unhandled gateway type: ${String(exhaustive)}`);
		}
	}
}

function defaultEnvTemplate(gatewayType: GatewayType, secretsProvider: SecretsProvider): string {
	switch (secretsProvider) {
		case '1password':
			return `# agent-vm environment configuration
# 1Password token is stored in macOS Keychain by agent-vm init.
# Only set this for CI or non-macOS environments:
# OP_SERVICE_ACCOUNT_TOKEN=
`;
		case 'environment': {
			const lines = [
				'# agent-vm environment configuration (environment-backed secrets)',
				'# Populate these variables in your runtime (container env, CI, shell, etc.).',
				'',
				...envVarsForGatewayType(gatewayType).map((name) => `# ${name}=`),
			];
			return `${lines.join('\n')}\n`;
		}
		default:
			return assertNeverSecretsProvider(secretsProvider);
	}
}

const gatewayDockerfileAuthBoundaryNote = `# NOTE: Do not bake auth tokens or credential material into this gateway image.
# Runtime auth must flow through controller HTTP mediation. Keep token env
# names, registry auth files, and build args out of this Dockerfile so a
# future edit cannot accidentally turn a runtime secret into image state.`;

const defaultGatewayDockerfile = `FROM node:24-slim

${gatewayDockerfileAuthBoundaryNote}

ENV PNPM_HOME=/pnpm
ENV PATH=\${PNPM_HOME}:\${PATH}

RUN apt-get update && \\
    apt-get install -y --no-install-recommends \\
      openssh-server \\
      ca-certificates \\
      git \\
      gh \\
      curl \\
      python3 && \\
    rm -rf /var/lib/apt/lists/* && \\
    update-ca-certificates && \\
    corepack enable && \\
    pnpm add -g openclaw@2026.4.24 && \\
    OPENCLAW_PACKAGE_ROOT="$(pnpm root -g)/openclaw" && \\
    (cd "$OPENCLAW_PACKAGE_ROOT" && node scripts/postinstall-bundled-plugins.mjs) && \\
    mkdir -p /opt/openclaw-sdk && \\
    ln -sf "$OPENCLAW_PACKAGE_ROOT/dist/plugin-sdk/sandbox.js" /opt/openclaw-sdk/sandbox.js && \\
    printf '#!/bin/sh\\nexec /pnpm/openclaw "$@"\\n' > /usr/local/bin/openclaw && \\
    chmod 755 /usr/local/bin/openclaw && \\
    useradd -m -s /bin/bash openclaw && \\
    mkdir -p ${defaultOpenClawExtensionsPath} /home/openclaw/workspace /run/sshd /root && \\
    chown -R openclaw:openclaw /home/openclaw && \\
    (ln -sf /proc/self/fd /dev/fd 2>/dev/null || true)

COPY vendor/gondolin ${defaultOpenClawExtensionsPath}/gondolin
`;

const defaultLocalWorkerGatewayDockerfile = `FROM node:24-slim

${gatewayDockerfileAuthBoundaryNote}

RUN apt-get update && \\
    apt-get install -y --no-install-recommends \\
      openssh-server \\
      ca-certificates \\
      git \\
      curl \\
      python3 && \\
    rm -rf /var/lib/apt/lists/* && \\
    update-ca-certificates && \\
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \\
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \\
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
      > /etc/apt/sources.list.d/github-cli.list && \\
    apt-get update && \\
    apt-get install -y --no-install-recommends gh && \\
    rm -rf /var/lib/apt/lists/* && \\
    npm install -g @openai/codex pnpm@10 && \\
    curl -LsSf https://astral.sh/uv/install.sh | sh && \\
    mv /root/.local/bin/uv /usr/local/bin/uv && \\
    mv /root/.local/bin/uvx /usr/local/bin/uvx && \\
    useradd -m -s /bin/bash coder && \\
    mkdir -p /workspace /run/sshd /state && \\
    chown -R coder:coder /workspace /state && \\
    (ln -sf /proc/self/fd /dev/fd 2>/dev/null || true)
`;

const defaultPodWorkerGatewayDockerfile = `FROM node:24-slim

${gatewayDockerfileAuthBoundaryNote}

RUN apt-get update && \\
    apt-get install -y --no-install-recommends \\
      openssh-server \\
      ca-certificates \\
      git \\
      curl \\
      python3 && \\
    rm -rf /var/lib/apt/lists/* && \\
    update-ca-certificates && \\
    npm install -g @openai/codex pnpm@10 && \\
    curl -LsSf https://astral.sh/uv/install.sh | sh && \\
    mv /root/.local/bin/uv /usr/local/bin/uv && \\
    mv /root/.local/bin/uvx /usr/local/bin/uvx && \\
    useradd -m -s /bin/bash coder && \\
    mkdir -p /workspace /run/sshd /state && \\
    chown -R coder:coder /workspace /state && \\
    (ln -sf /proc/self/fd /dev/fd 2>/dev/null || true)

# Install GitHub CLI. The agent uses gh for PR creation; GitHub
# auth is mediated by the controller proxy rather than exposed in
# the VM environment.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \\
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \\
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
    > /etc/apt/sources.list.d/github-cli.list && \\
    apt-get update && \\
    apt-get install -y --no-install-recommends gh && \\
    rm -rf /var/lib/apt/lists/*

# Install agent-vm-worker from deploy output copied into this directory
# by the container-host runtime stage at build time.
# pnpm deploy does not create a .bin entry for the deployed package itself,
# so point directly at the package bin entrypoint.
COPY agent-vm-worker/ /opt/agent-vm-worker/
RUN chmod +x /opt/agent-vm-worker/dist/main.js && \\
    ln -s /opt/agent-vm-worker/dist/main.js /usr/local/bin/agent-vm-worker
`;

const defaultToolVmDockerfile = `FROM node:24-slim

RUN apt-get update && \\
    apt-get install -y --no-install-recommends \\
      openssh-server \\
      ca-certificates \\
      git \\
      curl \\
      jq \\
      python3 \\
      ripgrep \\
      fd-find \\
      build-essential \\
      less \\
      tree \\
      nano \\
      vim-tiny && \\
    rm -rf /var/lib/apt/lists/* && \\
    update-ca-certificates && \\
    corepack enable && \\
    ln -sf /usr/bin/fdfind /usr/local/bin/fd && \\
    mkdir -p /workspace /run/sshd

WORKDIR /workspace
`;

function defaultWorkerGatewayDockerfile(paths: ScaffoldPathMode | undefined): string {
	return paths === 'pod' ? defaultPodWorkerGatewayDockerfile : defaultLocalWorkerGatewayDockerfile;
}

const defaultGatewayBuildConfig = (architecture: ImageArchitecture): object => ({
	arch: architecture,
	distro: 'alpine',
	alpine: {
		version: '3.23.0',
		kernelPackage: 'linux-virt',
		kernelImage: 'vmlinuz-virt',
		rootfsPackages: [],
		initramfsPackages: [],
	},
	oci: {
		image: 'agent-vm-gateway:latest',
		pullPolicy: 'never',
	},
	rootfs: {
		label: 'gondolin-root',
		sizeMb: 4096,
	},
});

const defaultToolBuildConfig = (architecture: ImageArchitecture): object => ({
	arch: architecture,
	distro: 'alpine',
	alpine: {
		version: '3.23.0',
		kernelPackage: 'linux-virt',
		kernelImage: 'vmlinuz-virt',
		rootfsPackages: [],
		initramfsPackages: [],
	},
	oci: {
		image: 'agent-vm-tool:latest',
		pullPolicy: 'never',
	},
	rootfs: {
		label: 'tool-root',
		sizeMb: 2048,
	},
});

const defaultOpenClawConfig = (zoneId: string, gatewayIngressPort: number): object => ({
	gateway: {
		auth: { mode: 'token' },
		bind: 'loopback',
		controlUi: {
			allowedOrigins: [
				`http://127.0.0.1:${gatewayIngressPort}`,
				`http://localhost:${gatewayIngressPort}`,
			],
		},
		mode: 'local',
		port: 18789,
	},
	agents: {
		defaults: {
			model: { primary: 'openai-codex/gpt-5.4' },
			models: {
				'openai-codex/gpt-5.4': {
					params: {
						thinking: 'low',
					},
				},
				'openai-codex/gpt-5.4-mini': {
					params: {
						thinking: 'high',
					},
				},
			},
			sandbox: { backend: 'gondolin', mode: 'all', scope: 'session' },
			workspace: '/home/openclaw/workspace',
		},
	},
	tools: { elevated: { enabled: false } },
	plugins: {
		load: {
			paths: [defaultOpenClawExtensionsPath],
		},
		entries: {
			gondolin: {
				enabled: true,
				config: {
					controllerUrl: 'http://controller.vm.host:18800',
					zoneId,
				},
			},
		},
	},
	channels: {},
});

async function resolveOpenClawControlUiIngressPort(
	systemConfigPath: string,
	zoneId: string,
): Promise<number> {
	try {
		const rawSystemConfig = await fs.readFile(systemConfigPath, 'utf8');
		const parsedSystemConfig: unknown = JSON.parse(rawSystemConfig);
		const parseResult = scaffoldedGatewayPortSystemConfigSchema.safeParse(parsedSystemConfig);
		if (!parseResult.success) {
			throw new Error(
				`Cannot scaffold OpenClaw config for zone '${zoneId}': system.json does not define zone gateway ports.`,
			);
		}
		const zone = parseResult.data.zones.find((candidateZone) => candidateZone.id === zoneId);
		if (!zone) {
			throw new Error(
				`Cannot scaffold OpenClaw config for zone '${zoneId}': system.json does not define zone '${zoneId}'.`,
			);
		}
		return zone.gateway.port;
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return defaultGatewayIngressPort;
		}
		if (error instanceof SyntaxError) {
			throw new Error(
				`Cannot scaffold OpenClaw config for zone '${zoneId}': system.json is not valid JSON.`,
				{ cause: error },
			);
		}
		throw error;
	}
}

const defaultWorkerPromptFiles = [
	{ fileName: 'common-agent-instructions.md', content: DEFAULT_COMMON_AGENT_INSTRUCTIONS },
	{ fileName: 'plan-agent.md', content: DEFAULT_PLAN_AGENT_INSTRUCTIONS },
	{ fileName: 'plan-reviewer.md', content: DEFAULT_PLAN_REVIEWER_INSTRUCTIONS },
	{ fileName: 'work-agent.md', content: DEFAULT_WORK_AGENT_INSTRUCTIONS },
	{ fileName: 'work-reviewer.md', content: DEFAULT_WORK_REVIEWER_INSTRUCTIONS },
	{ fileName: 'wrapup.md', content: DEFAULT_WRAPUP_INSTRUCTIONS },
] as const;

function defaultWorkerPromptReference(fileName: string): PromptReference {
	return { path: `./prompts/${fileName}` };
}

const defaultWorkerGatewayConfig = (): ScaffoldWorkerGatewayConfig => ({
	commonAgentInstructions: defaultWorkerPromptReference('common-agent-instructions.md'),
	defaults: {
		provider: 'codex',
		model: 'latest-medium',
	},
	phases: {
		plan: {
			cycle: { kind: 'review', cycleCount: 2 },
			agentInstructions: defaultWorkerPromptReference('plan-agent.md'),
			reviewerInstructions: defaultWorkerPromptReference('plan-reviewer.md'),
			agentTurnTimeoutMs: 900_000,
			reviewerTurnTimeoutMs: 900_000,
			skills: [],
		},
		work: {
			cycle: { kind: 'review', cycleCount: 4 },
			agentInstructions: defaultWorkerPromptReference('work-agent.md'),
			reviewerInstructions: defaultWorkerPromptReference('work-reviewer.md'),
			agentTurnTimeoutMs: 2_700_000,
			reviewerTurnTimeoutMs: 900_000,
			skills: [],
		},
		wrapup: {
			instructions: defaultWorkerPromptReference('wrapup.md'),
			turnTimeoutMs: 900_000,
			skills: [],
		},
	},
	mcpServers: [
		{
			name: 'deepwiki',
			url: 'https://mcp.deepwiki.com/mcp',
		},
	],
	verification: [],
	verificationTimeoutMs: 300_000,
	branchPrefix: 'agent/',
	stateDir: '/state',
});

async function writeFileIfMissing(
	filePath: string,
	content: string,
	overwrite = false,
): Promise<'created' | 'skipped'> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	if (overwrite) {
		await fs.writeFile(filePath, content, { encoding: 'utf8' });
		return 'created';
	}
	try {
		await fs.writeFile(filePath, content, {
			encoding: 'utf8',
			flag: 'wx',
		});
		return 'created';
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
			return 'skipped';
		}

		throw error;
	}
}

export function scaffoldAgentVmProject(
	options: ScaffoldAgentVmProjectOptions,
	dependencies: ScaffoldAgentVmProjectDependencies = {},
): Promise<ScaffoldAgentVmProjectResult> {
	return scaffoldAgentVmProjectInternal(options, dependencies);
}

async function scaffoldAgentVmProjectInternal(
	options: ScaffoldAgentVmProjectOptions,
	dependencies: ScaffoldAgentVmProjectDependencies = {},
): Promise<ScaffoldAgentVmProjectResult> {
	if (options.hostSystemType === 'container') {
		if (options.gatewayType !== 'worker') {
			throw new Error('Container-host scaffolds currently support only worker gateways.');
		}
		if (options.architecture !== 'x86_64') {
			throw new Error(
				'Container-host scaffolds currently support only x86_64. Use macos-local for aarch64 or add container-host arm64 support first.',
			);
		}
	}

	const created: string[] = [];
	const skipped: string[] = [];
	const gatewayType = options.gatewayType;
	const architecture = options.architecture;
	const overwrite = options.overwrite ?? false;
	const pathProfile = resolveScaffoldPathProfile(options.paths);
	const projectNamespace =
		options.projectNamespace ?? (await buildDefaultProjectNamespace(options.targetDir));
	const configDir = path.join(options.targetDir, 'config');
	const homeDir = dependencies.getHomeDir?.();
	const configWritablePathProfile = resolveConfigWritablePathProfile(
		pathProfile,
		configDir,
		homeDir,
	);

	const systemConfigPath = path.join(configDir, 'system.json');
	const systemConfigStatus = await writeFileIfMissing(
		systemConfigPath,
		`${JSON.stringify(
			defaultSystemConfig(
				options.zoneId,
				gatewayType,
				projectNamespace,
				options.secretsProvider,
				configWritablePathProfile,
			),
			null,
			'\t',
		)}\n`,
		overwrite,
	);
	(systemConfigStatus === 'created' ? created : skipped).push('config/system.json');

	const systemCacheIdentifierPath = path.join(
		options.targetDir,
		'config',
		SYSTEM_CACHE_IDENTIFIER_FILENAME,
	);
	const systemCacheIdentifier = buildDefaultSystemCacheIdentifier(
		options.hostSystemType ? { hostSystemType: options.hostSystemType } : {},
	);
	const systemCacheIdentifierStatus = await writeFileIfMissing(
		systemCacheIdentifierPath,
		`${JSON.stringify(systemCacheIdentifier, null, '\t')}\n`,
		overwrite,
	);
	(systemCacheIdentifierStatus === 'created' ? created : skipped).push(
		`config/${SYSTEM_CACHE_IDENTIFIER_FILENAME}`,
	);

	if (options.writeLocalEnvironmentFile) {
		const envFilePath = path.join(options.targetDir, '.env.local');
		const envFileStatus = await writeFileIfMissing(
			envFilePath,
			defaultEnvTemplate(gatewayType, options.secretsProvider),
			overwrite,
		);
		(envFileStatus === 'created' ? created : skipped).push('.env.local');
	}

	const configFileName = resolveGatewayConfigFileName(gatewayType);
	const configPath = path.join(
		options.targetDir,
		'config',
		'gateways',
		options.zoneId,
		configFileName,
	);
	const configStatus = await writeFileIfMissing(
		configPath,
		`${JSON.stringify(
			gatewayType === 'openclaw'
				? defaultOpenClawConfig(
						options.zoneId,
						await resolveOpenClawControlUiIngressPort(systemConfigPath, options.zoneId),
					)
				: defaultWorkerGatewayConfig(),
			null,
			'\t',
		)}\n`,
		overwrite,
	);
	(configStatus === 'created' ? created : skipped).push(
		`config/gateways/${options.zoneId}/${configFileName}`,
	);
	if (gatewayType === 'worker') {
		const promptFileResults = await Promise.all(
			defaultWorkerPromptFiles.map(async (promptFile) => {
				const promptFilePath = path.join(
					options.targetDir,
					'config',
					'gateways',
					options.zoneId,
					'prompts',
					promptFile.fileName,
				);
				return {
					fileName: promptFile.fileName,
					status: await writeFileIfMissing(promptFilePath, `${promptFile.content}\n`, overwrite),
				};
			}),
		);
		for (const promptFileResult of promptFileResults) {
			const promptFileStatus = promptFileResult.status;
			(promptFileStatus === 'created' ? created : skipped).push(
				`config/gateways/${options.zoneId}/prompts/${promptFileResult.fileName}`,
			);
		}
	}

	const gatewayDockerfilePath = path.join(
		options.targetDir,
		'vm-images',
		'gateways',
		gatewayType,
		'Dockerfile',
	);
	const gatewayDockerfileStatus = await writeFileIfMissing(
		gatewayDockerfilePath,
		gatewayType === 'openclaw'
			? defaultGatewayDockerfile
			: defaultWorkerGatewayDockerfile(options.paths),
		overwrite,
	);
	(gatewayDockerfileStatus === 'created' ? created : skipped).push(
		`vm-images/gateways/${gatewayType}/Dockerfile`,
	);

	const gatewayBuildConfigPath = path.join(
		options.targetDir,
		'vm-images',
		'gateways',
		gatewayType,
		'build-config.json',
	);
	const gatewayBuildConfigStatus = await writeFileIfMissing(
		gatewayBuildConfigPath,
		`${JSON.stringify(defaultGatewayBuildConfig(architecture), null, '\t')}\n`,
		overwrite,
	);
	(gatewayBuildConfigStatus === 'created' ? created : skipped).push(
		`vm-images/gateways/${gatewayType}/build-config.json`,
	);
	if (gatewayType === 'openclaw') {
		const pluginCopyStatus = await (
			dependencies.copyBundledOpenClawPlugin ?? syncBundledOpenClawPluginBundle
		)(options.targetDir, gatewayType);
		(pluginCopyStatus === 'created' ? created : skipped).push(
			openClawPluginVendorDirectory(gatewayType),
		);
	}

	if (gatewayType === 'openclaw') {
		const toolBuildConfigPath = path.join(
			options.targetDir,
			'vm-images',
			'tool-vms',
			'default',
			'build-config.json',
		);
		const toolBuildConfigStatus = await writeFileIfMissing(
			toolBuildConfigPath,
			`${JSON.stringify(defaultToolBuildConfig(architecture), null, '\t')}\n`,
			overwrite,
		);
		(toolBuildConfigStatus === 'created' ? created : skipped).push(
			'vm-images/tool-vms/default/build-config.json',
		);
		const toolDockerfilePath = path.join(
			options.targetDir,
			'vm-images',
			'tool-vms',
			'default',
			'Dockerfile',
		);
		const toolDockerfileStatus = await writeFileIfMissing(
			toolDockerfilePath,
			defaultToolVmDockerfile,
			overwrite,
		);
		(toolDockerfileStatus === 'created' ? created : skipped).push(
			'vm-images/tool-vms/default/Dockerfile',
		);
	}

	if (options.hostSystemType === 'container') {
		const resolveZigVersion =
			dependencies.resolveGondolinMinimumZigVersion ?? resolveGondolinMinimumZigVersion;
		const zigVersion = await resolveZigVersion();
		const gondolinPackageSpec = await resolveGondolinPackageSpec();
		const vmHostSystemFiles = [
			[
				'Dockerfile',
				renderVmHostSystemDockerfile({
					gondolinPackageSpec,
					imageArchitecture: options.architecture,
					zigVersion,
				}),
			],
			['start.sh', renderVmHostSystemStartScript({ zoneId: options.zoneId })],
			['agent-vm-controller.service', renderVmHostSystemSystemdUnit()],
			['README.md', renderVmHostSystemReadme({ zoneId: options.zoneId })],
		] as const satisfies readonly (readonly [string, string])[];

		await Promise.all(
			vmHostSystemFiles.map(async ([relativeFilePath, content]) => {
				const status = await writeFileIfMissing(
					path.join(options.targetDir, 'vm-host-system', relativeFilePath),
					content,
					overwrite,
				);
				(status === 'created' ? created : skipped).push(`vm-host-system/${relativeFilePath}`);
			}),
		);
	}

	if (pathProfile.createLocalRuntimeDirectories) {
		const directoriesToCreate = [
			pathProfile.cacheDir,
			pathProfile.runtimeDir,
			pathProfile.gatewayStateDir(options.zoneId),
			...(gatewayType === 'openclaw' ? [pathProfile.gatewayZoneFilesDir(options.zoneId)] : []),
			pathProfile.gatewayBackupDir(options.zoneId),
			pathProfile.toolWorkspaceRoot,
		].map((profilePath) => resolveConfigPath(profilePath, configDir, homeDir));
		await Promise.all(
			directoriesToCreate.map((directoryPath) => fs.mkdir(directoryPath, { recursive: true })),
		);
	}

	return { created, keychainStored: false, skipped };
}

/**
 * Interactively prompt for the 1Password service account token and store it
 * in macOS Keychain. Skips if stdin is not a TTY or if a token already exists.
 */
export async function promptAndStoreServiceAccountToken(
	dependencies: PromptAndStoreTokenDependencies = {},
): Promise<boolean> {
	const hasToken = dependencies.hasKeychainToken ?? hasServiceAccountToken;
	const storeToken = dependencies.storeKeychainToken ?? storeServiceAccountToken;

	if (hasToken()) {
		return false;
	}

	if (!process.stdin.isTTY) {
		return false;
	}

	// Use a muted output stream so readline doesn't echo the token
	const { Writable } = await import('node:stream');
	const mutedOutput = new Writable({
		write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
			callback();
		},
	});

	const rl =
		dependencies.createReadlineInterface?.() ??
		readline.createInterface({ input: process.stdin, output: mutedOutput, terminal: true });

	try {
		process.stderr.write(
			'Paste your 1Password service account token (from https://my.1password.com/developer-tools/service-accounts):\n> ',
		);
		const token = await rl.question('');
		process.stderr.write('\n');

		const trimmedToken = token.trim();
		if (!trimmedToken) {
			return false;
		}

		storeToken(trimmedToken);
		process.stderr.write('✓ Stored in macOS Keychain\n');
		return true;
	} finally {
		rl.close();
	}
}
