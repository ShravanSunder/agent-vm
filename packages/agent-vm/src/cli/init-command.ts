import { access, mkdir, writeFile } from 'node:fs/promises';
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

import { loadJsonConfigFile } from '../config/json-config-file.js';
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
import { updateAgentVmManual } from './manual-commands.js';
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
	readonly gatewayOverlay: (gatewayType: GatewayType) => string;
	readonly toolVmBuildConfig: string;
	readonly toolVmOverlay: string;
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

function resolveGatewayConfigFileName(gatewayType: GatewayType): 'worker.jsonc' | 'openclaw.json' {
	return gatewayType === 'worker' ? 'worker.jsonc' : 'openclaw.json';
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
	gatewayBuildConfig: (gatewayType) => `../vm-images/gateways/${gatewayType}/build-config.jsonc`,
	gatewayOverlay: (gatewayType) => `../vm-images/gateways/${gatewayType}/overlay.jsonc`,
	toolVmBuildConfig: '../vm-images/tool-vms/default/build-config.jsonc',
	toolVmOverlay: '../vm-images/tool-vms/default/overlay.jsonc',
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
		`/etc/agent-vm/vm-images/gateways/${gatewayType}/build-config.jsonc`,
	gatewayOverlay: (gatewayType) => `/etc/agent-vm/vm-images/gateways/${gatewayType}/overlay.jsonc`,
	toolVmBuildConfig: '/etc/agent-vm/vm-images/tool-vms/default/build-config.jsonc',
	toolVmOverlay: '/etc/agent-vm/vm-images/tool-vms/default/overlay.jsonc',
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
	gatewayBuildConfig: (gatewayType) => `../vm-images/gateways/${gatewayType}/build-config.jsonc`,
	gatewayOverlay: (gatewayType) => `../vm-images/gateways/${gatewayType}/overlay.jsonc`,
	toolVmBuildConfig: '../vm-images/tool-vms/default/build-config.jsonc',
	toolVmOverlay: '../vm-images/tool-vms/default/overlay.jsonc',
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
		toolVmOverlay: resolveHomeRelativeScaffoldPath(pathProfile.toolVmOverlay, configDir, homeDir),
	};
}

function defaultToolVmImageProfiles(
	gatewayType: GatewayType,
	pathProfile: ScaffoldPathProfile,
): Record<
	string,
	{
		readonly type: 'toolVm';
		readonly buildConfig: string;
		readonly source: {
			readonly kind: 'managedBase';
			readonly base: 'tool-vm';
			readonly overlay: string;
		};
	}
> {
	if (gatewayType !== 'openclaw') {
		return {};
	}
	return {
		default: {
			type: 'toolVm',
			buildConfig: pathProfile.toolVmBuildConfig,
			source: {
				kind: 'managedBase',
				base: 'tool-vm',
				overlay: pathProfile.toolVmOverlay,
			},
		},
	};
}

function defaultGatewayManagedBase(
	gatewayType: GatewayType,
): 'openclaw-gateway' | 'worker-gateway' {
	return gatewayType === 'openclaw' ? 'openclaw-gateway' : 'worker-gateway';
}

function defaultManagedImageOverlay(): object {
	return {
		schemaVersion: 1,
		extraAptPackages: [],
	};
}

function defaultToolVmProfiles(gatewayType: GatewayType): Record<
	string,
	{
		readonly memory: string;
		readonly cpus: number;
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
				source: {
					kind: 'managedBase',
					base: defaultGatewayManagedBase(gatewayType),
					overlay: pathProfile.gatewayOverlay(gatewayType),
				},
			},
		},
		toolVms: defaultToolVmImageProfiles(gatewayType, pathProfile),
	},
	zones: [
		{
			id: zoneId,
			adminAccess: {
				mode: 'secret',
				secret: defaultZoneSshAccessSecret(zoneId, secretsProvider),
			},
			gateway: {
				type: gatewayType,
				memory: '2G',
				cpus: 2,
				port: defaultGatewayIngressPort,
				config: pathProfile.gatewayConfig(zoneId, gatewayType),
				imageProfile: gatewayType,
				stateDir: pathProfile.gatewayStateDir(zoneId),
				ssh: { secretEnv: 'explicit' },
				...(gatewayType === 'openclaw'
					? {
							zoneFilesDir: pathProfile.gatewayZoneFilesDir(zoneId),
							authProfilesByAgent: {},
						}
					: {}),
				backupDir: pathProfile.gatewayBackupDir(zoneId),
			},
			secrets: defaultSecretsForGatewayType(zoneId, gatewayType, secretsProvider),
			runtimeAuthHints: defaultRuntimeAuthHintsForGatewayType(gatewayType),
			allowedHosts: defaultAllowedHostsForGatewayType(gatewayType),
			websocketBypass: defaultWebsocketBypassForGatewayType(gatewayType),
			...(gatewayType === 'openclaw'
				? { defaultToolVmProfile: 'standard', agentToolVmProfiles: {}, agentSandboxSeeds: {} }
				: {}),
		},
	],
	toolVmProfiles: defaultToolVmProfiles(gatewayType),
	tcpPool: {
		basePort: 19000,
		size: 12,
	},
});

type SecretInjection = 'env' | 'http-mediation';

type HostGithubToken =
	| { readonly source: '1password'; readonly ref: string }
	| { readonly source: 'environment'; readonly envVar: string };

type AdminAccessReference =
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

function defaultZoneSshAccessSecret(
	zoneId: string,
	secretsProvider: SecretsProvider,
): AdminAccessReference {
	switch (secretsProvider) {
		case '1password':
			return { source: '1password', ref: `op://agent-vm/${zoneId}-ssh-access/token` };
		case 'environment':
			return { source: 'environment', envVar: defaultZoneSshAccessEnvVar(zoneId) };
		default:
			return assertNeverSecretsProvider(secretsProvider);
	}
}

function defaultZoneSshAccessEnvVar(zoneId: string): string {
	const zoneSegment = zoneId
		.replace(/[^A-Z0-9]+/giu, '_')
		.replace(/^_+|_+$/gu, '')
		.toUpperCase();
	return `AGENT_VM_${zoneSegment}_SSH_ACCESS_TOKEN`;
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
		'api.github.com',
		'registry.npmjs.org',
	];
}

function defaultWebsocketBypassForGatewayType(gatewayType: GatewayType): readonly string[] {
	if (gatewayType === 'worker') {
		return [];
	}

	return [];
}

function envVarsForGatewayType(gatewayType: GatewayType, zoneId: string): readonly string[] {
	const zoneSshAccessEnvVar = defaultZoneSshAccessEnvVar(zoneId);
	switch (gatewayType) {
		case 'worker':
			return ['GITHUB_TOKEN', 'OPENAI_API_KEY', zoneSshAccessEnvVar];
		case 'openclaw':
			return ['GITHUB_TOKEN', 'PERPLEXITY_API_KEY', 'OPENCLAW_GATEWAY_TOKEN', zoneSshAccessEnvVar];
		default: {
			const exhaustive: never = gatewayType;
			throw new Error(`Unhandled gateway type: ${String(exhaustive)}`);
		}
	}
}

function defaultEnvTemplate(
	gatewayType: GatewayType,
	secretsProvider: SecretsProvider,
	zoneId: string,
): string {
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
				...envVarsForGatewayType(gatewayType, zoneId).map((name) => `# ${name}=`),
			];
			return `${lines.join('\n')}\n`;
		}
		default:
			return assertNeverSecretsProvider(secretsProvider);
	}
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
			sandbox: {
				backend: 'gondolin',
				mode: 'all',
				scope: 'agent',
				workspaceAccess: 'rw',
			},
			workspace: '/zone/agents/default',
		},
	},
	tools: { elevated: { enabled: false } },
	commands: { ownerAllowFrom: [] },
	session: { dmScope: 'per-channel-peer' },
	plugins: {
		load: {
			paths: [defaultOpenClawExtensionsPath, '/pnpm/global/5/node_modules/@openclaw'],
		},
		allow: ['gondolin', 'memory-core'],
		slots: { memory: 'memory-core' },
		entries: {
			gondolin: {
				enabled: true,
				config: {
					controllerUrl: 'http://controller.vm.host:18800',
					zoneId,
				},
			},
			'memory-core': {
				enabled: true,
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
		const parsedSystemConfig = await loadJsonConfigFile(systemConfigPath);
		const parseResult = scaffoldedGatewayPortSystemConfigSchema.safeParse(parsedSystemConfig);
		if (!parseResult.success) {
			throw new Error(
				`Cannot scaffold OpenClaw config for zone '${zoneId}': system config does not define zone gateway ports.`,
			);
		}
		const zone = parseResult.data.zones.find((candidateZone) => candidateZone.id === zoneId);
		if (!zone) {
			throw new Error(
				`Cannot scaffold OpenClaw config for zone '${zoneId}': system config does not define zone '${zoneId}'.`,
			);
		}
		return zone.gateway.port;
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return defaultGatewayIngressPort;
		}
		throw error;
	}
}

function formatJsoncConfig(comment: string, value: unknown): string {
	return `// ${comment}\n${JSON.stringify(value, null, '\t')}\n`;
}

function formatAuthoredConfig(filePath: string, comment: string, value: unknown): string {
	if (filePath.endsWith('.jsonc')) {
		return formatJsoncConfig(comment, value);
	}
	return `${JSON.stringify(value, null, '\t')}\n`;
}

async function resolveScaffoldSystemConfigPath(configDir: string): Promise<string> {
	const legacyJsonPath = path.join(configDir, 'system.json');
	try {
		await access(legacyJsonPath);
		return legacyJsonPath;
	} catch (error) {
		if (
			!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
		) {
			throw error;
		}
	}
	return path.join(configDir, 'system.jsonc');
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
	await mkdir(path.dirname(filePath), { recursive: true });
	if (overwrite) {
		await writeFile(filePath, content, { encoding: 'utf8' });
		return 'created';
	}
	try {
		await writeFile(filePath, content, {
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

	const systemConfigPath = await resolveScaffoldSystemConfigPath(configDir);
	const systemConfigRelativePath = path.relative(options.targetDir, systemConfigPath);
	const systemConfigStatus = await writeFileIfMissing(
		systemConfigPath,
		formatAuthoredConfig(
			systemConfigPath,
			'Human-authored agent-vm system config. Comments are allowed here; runtime effective files stay strict JSON.',
			defaultSystemConfig(
				options.zoneId,
				gatewayType,
				projectNamespace,
				options.secretsProvider,
				configWritablePathProfile,
			),
		),
		overwrite,
	);
	(systemConfigStatus === 'created' ? created : skipped).push(systemConfigRelativePath);

	const systemCacheIdentifierPath = path.join(
		options.targetDir,
		'config',
		SYSTEM_CACHE_IDENTIFIER_FILENAME,
	);
	const systemCacheIdentifier = buildDefaultSystemCacheIdentifier(
		options.hostSystemType === 'container'
			? { hostSystemType: options.hostSystemType, platform: () => 'linux' }
			: options.hostSystemType
				? { hostSystemType: options.hostSystemType }
				: {},
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
			defaultEnvTemplate(gatewayType, options.secretsProvider, options.zoneId),
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
		gatewayType === 'openclaw'
			? `${JSON.stringify(
					defaultOpenClawConfig(
						options.zoneId,
						await resolveOpenClawControlUiIngressPort(systemConfigPath, options.zoneId),
					),
					null,
					'\t',
				)}\n`
			: formatJsoncConfig(
					'Human-authored Agent Worker gateway config. Comments are allowed here; /state/effective-worker.json stays strict JSON.',
					defaultWorkerGatewayConfig(),
				),
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

	const gatewayOverlayPath = path.join(
		options.targetDir,
		'vm-images',
		'gateways',
		gatewayType,
		'overlay.jsonc',
	);
	const gatewayOverlayStatus = await writeFileIfMissing(
		gatewayOverlayPath,
		formatJsoncConfig(
			'Human-authored managed gateway image overlay. Comments are allowed here.',
			defaultManagedImageOverlay(),
		),
		overwrite,
	);
	(gatewayOverlayStatus === 'created' ? created : skipped).push(
		`vm-images/gateways/${gatewayType}/overlay.jsonc`,
	);

	const gatewayBuildConfigPath = path.join(
		options.targetDir,
		'vm-images',
		'gateways',
		gatewayType,
		'build-config.jsonc',
	);
	const gatewayBuildConfigStatus = await writeFileIfMissing(
		gatewayBuildConfigPath,
		formatJsoncConfig(
			'Human-authored Gondolin image build config. Comments are allowed here.',
			defaultGatewayBuildConfig(architecture),
		),
		overwrite,
	);
	(gatewayBuildConfigStatus === 'created' ? created : skipped).push(
		`vm-images/gateways/${gatewayType}/build-config.jsonc`,
	);
	if (gatewayType === 'openclaw') {
		const toolBuildConfigPath = path.join(
			options.targetDir,
			'vm-images',
			'tool-vms',
			'default',
			'build-config.jsonc',
		);
		const toolBuildConfigStatus = await writeFileIfMissing(
			toolBuildConfigPath,
			formatJsoncConfig(
				'Human-authored Tool VM image build config. Comments are allowed here.',
				defaultToolBuildConfig(architecture),
			),
			overwrite,
		);
		(toolBuildConfigStatus === 'created' ? created : skipped).push(
			'vm-images/tool-vms/default/build-config.jsonc',
		);
		const toolOverlayPath = path.join(
			options.targetDir,
			'vm-images',
			'tool-vms',
			'default',
			'overlay.jsonc',
		);
		const toolOverlayStatus = await writeFileIfMissing(
			toolOverlayPath,
			formatJsoncConfig(
				'Human-authored managed Tool VM image overlay. Comments are allowed here.',
				defaultManagedImageOverlay(),
			),
			overwrite,
		);
		(toolOverlayStatus === 'created' ? created : skipped).push(
			'vm-images/tool-vms/default/overlay.jsonc',
		);
	}

	const manualResult = await updateAgentVmManual({
		defaultZoneId: options.zoneId,
		systemConfigPath: systemConfigRelativePath,
		targetDir: options.targetDir,
		updateAgentIndex: true,
	});
	created.push(...manualResult.updated);

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
		].map((profilePath) => resolveConfigPath(profilePath, configDir, homeDir));
		await Promise.all(
			directoriesToCreate.map((directoryPath) => mkdir(directoryPath, { recursive: true })),
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
