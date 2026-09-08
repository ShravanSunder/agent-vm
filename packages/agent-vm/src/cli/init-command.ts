import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';

import {
	createConfigContractSchemaArtifacts,
	mcpPortalConfigSchemaPaths,
} from '@agent-vm/config-contracts';
import type { EgressHostConfig, VmAudience } from '@agent-vm/gateway-lifecycle';

import {
	resolveManagedVmBackendPackageSpec,
	resolveManagedVmMinimumZigVersion,
} from '../build/managed-vm-build-tooling.js';
import { resolveConfigPath } from '../config/path-resolver.js';
import { projectNamespaceSchema } from '../config/system-config-identifier-schemas.js';
import {
	createSystemConfigSchemaArtifact,
	deploymentGeneratedDirForStorageRoot,
	sharedImageCacheDirForStorageRoot,
} from '../config/system-config.js';
import { buildDefaultProjectNamespace } from '../runtime/project-namespace.js';
import { resolveCliVersion } from './cli-version.js';
import {
	createHermesProfileAssignments,
	createHermesProfileSecretProjections,
	createHermesScaffoldImageRecipe,
	createHermesScaffoldSecrets,
	renderHermesManagedConfiguration,
	resolveHermesScaffoldAgentIds,
} from './hermes-scaffold-recipe.js';
import {
	type GatewayType,
	type HostSystemType,
	type ImageArchitecture,
	type ScaffoldPathMode,
	type SecretsProvider,
} from './init-command-schemas.js';
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

export interface ScaffoldAgentVmProjectOptions {
	readonly agents?: readonly string[];
	readonly architecture: ImageArchitecture;
	readonly gatewayType: GatewayType;
	readonly hostSystemType?: HostSystemType;
	readonly onePasswordKeychainAccountName?: string;
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
	readonly getHomeDir?: () => string;
	readonly resolveManagedVmMinimumZigVersion?: typeof resolveManagedVmMinimumZigVersion;
}

export interface PromptAndStoreTokenDependencies {
	readonly account?: string;
	readonly accountName?: string;
	readonly hasKeychainToken?: () => boolean;
	readonly service?: string;
	readonly storeKeychainToken?: (token: string) => void;
	readonly createReadlineInterface?: () => readline.Interface;
}

interface ScaffoldPathProfile {
	readonly storageRootDir: string;
	readonly createLocalRuntimeDirectories: boolean;
	readonly gatewayConfig: (zoneId: string, gatewayType: GatewayType) => string;
	readonly gatewayConfigDir: (zoneId: string) => string;
	readonly gatewayDockerfile: (gatewayType: GatewayType) => string;
	readonly gatewayBackupDir: (zoneId: string) => string;
	readonly gatewayBuildConfig: (gatewayType: GatewayType) => string;
	readonly toolVmBuildConfig: string;
	readonly toolVmOverlay: string;
}

interface DefaultManagedImageOverlay {
	readonly schemaVersion: 1;
	readonly extraAptPackages: readonly string[];
	readonly copy: readonly [];
	readonly runAfterBase: readonly string[];
}

const defaultGatewayIngressPort = 18791;

function resolveGatewayConfigFileName(_gatewayType: GatewayType): 'hermes-managed/config.yaml' {
	return 'hermes-managed/config.yaml';
}

const localPathProfile: ScaffoldPathProfile = {
	storageRootDir: '../.agent-vm',
	createLocalRuntimeDirectories: true,
	gatewayConfig: (zoneId, gatewayType) =>
		`./gateways/${zoneId}/${resolveGatewayConfigFileName(gatewayType)}`,
	gatewayConfigDir: (zoneId) => `./gateways/${zoneId}`,
	gatewayDockerfile: (gatewayType) => `../vm-images/gateways/${gatewayType}/Dockerfile`,
	gatewayBackupDir: (zoneId) => `../backups/${zoneId}`,
	gatewayBuildConfig: (gatewayType) => `../vm-images/gateways/${gatewayType}/build-config.jsonc`,
	toolVmBuildConfig: '../vm-images/tool-vms/default/build-config.jsonc',
	toolVmOverlay: '../vm-images/tool-vms/default/overlay.jsonc',
};

const podPathProfile: ScaffoldPathProfile = {
	storageRootDir: '/var/agent-vm',
	createLocalRuntimeDirectories: false,
	gatewayConfig: (zoneId, gatewayType) =>
		`/etc/agent-vm/gateways/${zoneId}/${resolveGatewayConfigFileName(gatewayType)}`,
	gatewayConfigDir: (zoneId) => `/etc/agent-vm/gateways/${zoneId}`,
	gatewayDockerfile: (gatewayType) => `/etc/agent-vm/vm-images/gateways/${gatewayType}/Dockerfile`,
	gatewayBackupDir: () => '/var/agent-vm/backups',
	gatewayBuildConfig: (gatewayType) =>
		`/etc/agent-vm/vm-images/gateways/${gatewayType}/build-config.jsonc`,
	toolVmBuildConfig: '/etc/agent-vm/vm-images/tool-vms/default/build-config.jsonc',
	toolVmOverlay: '/etc/agent-vm/vm-images/tool-vms/default/overlay.jsonc',
};

/**
 * User-home profile: runtime state in ~/.agent-vm/<projectNamespace>/, backups in
 * ~/.agent-vm-backups/ so a wipe of the runtime tree can't take
 * its own recovery archive with it.  Catalog files (gateway
 * config, image recipes) stay in-repo.
 */
const userDirPathProfile: ScaffoldPathProfile = {
	storageRootDir: '~/.agent-vm',
	createLocalRuntimeDirectories: true,
	gatewayConfig: (zoneId, gatewayType) =>
		`./gateways/${zoneId}/${resolveGatewayConfigFileName(gatewayType)}`,
	gatewayConfigDir: (zoneId) => `./gateways/${zoneId}`,
	gatewayDockerfile: (gatewayType) => `../vm-images/gateways/${gatewayType}/Dockerfile`,
	gatewayBackupDir: (zoneId) => `~/.agent-vm-backups/${zoneId}`,
	gatewayBuildConfig: (gatewayType) => `../vm-images/gateways/${gatewayType}/build-config.jsonc`,
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
		storageRootDir: resolveHomeRelativeScaffoldPath(pathProfile.storageRootDir, configDir, homeDir),
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
	void gatewayType;
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

function defaultManagedImageOverlay(): DefaultManagedImageOverlay {
	return {
		schemaVersion: 1,
		extraAptPackages: [],
		copy: [],
		runAfterBase: [],
	} satisfies DefaultManagedImageOverlay;
}

function defaultToolVmProfiles(gatewayType: GatewayType): Record<
	string,
	{
		readonly memory: string;
		readonly cpus: number;
		readonly imageProfile: string;
		readonly runtimeRootfsSize?: string;
	}
> {
	void gatewayType;
	return {
		standard: {
			memory: '1G',
			cpus: 1,
			imageProfile: 'default',
			runtimeRootfsSize: '16G',
		},
	};
}

const defaultSystemConfig = (
	zoneId: string,
	gatewayType: GatewayType,
	projectNamespace: string,
	secretsProvider: SecretsProvider,
	pathProfile: ScaffoldPathProfile,
	onePasswordKeychainAccountName: string | undefined,
	agentIds?: readonly string[],
): object => ({
	$schema: './schemas/system.schema.json',
	schemaVersion: 2,
	host: {
		controllerPort: 18800,
		projectNamespace,
		githubToken: defaultHostGithubToken(secretsProvider),
		...(secretsProvider === '1password'
			? {
					secretsProvider: {
						type: '1password',
						tokenSource: getKeychainTokenSource(
							onePasswordKeychainAccountName === undefined
								? {}
								: { accountName: onePasswordKeychainAccountName },
						),
					},
				}
			: {}),
	},
	storageRootDir: pathProfile.storageRootDir,
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
			adminAccess: { mode: 'none' },
			gateway: {
				type: gatewayType,
				memory: '2G',
				cpus: 2,
				port: defaultGatewayIngressPort,
				config: pathProfile.gatewayConfig(zoneId, gatewayType),
				imageProfile: gatewayType,
				runtimeRootfsSize: '12G',
				profileSecretProjectionsByAgent: createHermesProfileSecretProjections(agentIds),
				profilesByAgent: createHermesProfileAssignments(agentIds),
				backupDir: pathProfile.gatewayBackupDir(zoneId),
			},
			secrets: defaultSecretsForGatewayType(zoneId, gatewayType, secretsProvider, agentIds),
			egressHosts: defaultEgressHostsForGatewayType(gatewayType),
			defaultToolVmProfile: 'standard',
			agentToolVmProfiles: {},
			agents: resolveHermesScaffoldAgentIds(agentIds).map((agentId) => ({ id: agentId })),
			toolPortal: {
				configDir: pathProfile.gatewayConfigDir(zoneId),
				surfaceEligibilityByProfile: { default: {} },
			},
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

type SecretReference =
	| {
			readonly source: '1password';
			readonly ref: string;
			readonly injection: SecretInjection;
			readonly audience: VmAudience;
			readonly hosts?: readonly string[];
	  }
	| {
			readonly source: 'environment';
			readonly envVar: string;
			readonly injection: SecretInjection;
			readonly audience: VmAudience;
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

function defaultSecretsForGatewayType(
	zoneId: string,
	_gatewayType: GatewayType,
	secretsProvider: SecretsProvider,
	agentIds: readonly string[] | undefined,
): Record<string, SecretReference> {
	return createHermesScaffoldSecrets({ agentIds, secretsProvider, zoneId });
}

function defaultEgressHostsForGatewayType(_gatewayType: GatewayType): readonly EgressHostConfig[] {
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
	].map((host) => ({ host, audience: 'gateway' }));
}

function envVarsForGatewayType(
	gatewayType: GatewayType,
	zoneId: string,
	agentIds: readonly string[] | undefined,
): readonly string[] {
	void zoneId;
	void gatewayType;
	return [
		'API_SERVER_KEY',
		...resolveHermesScaffoldAgentIds(agentIds).flatMap((agentId) => {
			const suffix = agentId.toUpperCase().replaceAll(/[^A-Z0-9]/gu, '_');
			return [`HERMES_API_SERVER_KEY_${suffix}`, `DISCORD_BOT_TOKEN_${suffix}`];
		}),
	];
}

function defaultEnvTemplate(
	gatewayType: GatewayType,
	secretsProvider: SecretsProvider,
	zoneId: string,
	agentIds: readonly string[] | undefined,
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
				...envVarsForGatewayType(gatewayType, zoneId, agentIds).map((name) => `# ${name}=`),
			];
			return `${lines.join('\n')}\n`;
		}
		default:
			return assertNeverSecretsProvider(secretsProvider);
	}
}

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
		sizeMb: 4096,
	},
});

function defaultMcpProviderConfig(): object {
	return {
		$schema: mcpPortalConfigSchemaPaths.mcpFromGatewayConfig,
		schemaVersion: 1,
		providers: {},
	};
}

function defaultToolPortalAgentAssignments(agentIds: readonly string[] | undefined): object {
	return Object.fromEntries(
		resolveHermesScaffoldAgentIds(agentIds).map((agentId) => [agentId, { profile: 'default' }]),
	);
}

function defaultToolPortalConfig(agentIds: readonly string[] | undefined): object {
	return {
		$schema: mcpPortalConfigSchemaPaths.toolPortalFromGatewayConfig,
		schemaVersion: 1,
		agents: defaultToolPortalAgentAssignments(agentIds),
		mode: 'managed',
		profiles: {
			default: {
				namespaces: {},
			},
		},
	};
}

function formatJsoncConfig(comment: string, value: unknown): string {
	const formattedComment = comment
		.split('\n')
		.map((line) => `// ${line}`)
		.join('\n');
	return `${formattedComment}\n${JSON.stringify(value, null, '\t')}\n`;
}

function formatJsonSchemaArtifact(value: Record<string, unknown>): string {
	return `${JSON.stringify(value, null, '\t')}\n`;
}

function formatAuthoredConfig(filePath: string, comment: string, value: unknown): string {
	if (filePath.endsWith('.jsonc')) {
		return formatJsoncConfig(comment, value);
	}
	return `${JSON.stringify(value, null, '\t')}\n`;
}

export async function resolveScaffoldSystemConfigPath(configDir: string): Promise<string> {
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

async function writeConfigSchemaArtifacts(options: {
	readonly configDir: string;
	readonly created: string[];
	readonly overwrite: boolean;
	readonly skipped: string[];
	readonly targetDir: string;
}): Promise<void> {
	const contractSchemas = createConfigContractSchemaArtifacts();
	const schemas: Readonly<Record<string, Record<string, unknown>>> = {
		'system.schema.json': createSystemConfigSchemaArtifact(),
		'mcp.schema.json': contractSchemas.mcp,
		'mcp-portal.schema.json': contractSchemas.mcpPortal,
		'tool-portal.schema.json': contractSchemas.toolPortal,
	};
	const schemaWriteResults = await Promise.all(
		Object.entries(schemas).map(async ([fileName, schema]) => {
			const schemaPath = path.join(options.configDir, 'schemas', fileName);
			return {
				schemaPath,
				status: await writeFileIfMissing(
					schemaPath,
					formatJsonSchemaArtifact(schema),
					options.overwrite,
				),
			};
		}),
	);
	for (const { schemaPath, status } of schemaWriteResults) {
		(status === 'created' ? options.created : options.skipped).push(
			path.relative(options.targetDir, schemaPath),
		);
	}
}

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
	const created: string[] = [];
	const skipped: string[] = [];
	const gatewayType = options.gatewayType;
	const architecture = options.architecture;
	const hermesImageRecipe = createHermesScaffoldImageRecipe({
		agentVmVersion: await resolveCliVersion(),
		architecture,
	});
	const overwrite = options.overwrite ?? false;
	const projectNamespace = projectNamespaceSchema.parse(
		options.projectNamespace ?? (await buildDefaultProjectNamespace(options.targetDir)),
	);
	const basePathProfile = resolveScaffoldPathProfile(options.paths);
	const pathProfile: ScaffoldPathProfile = {
		...basePathProfile,
		storageRootDir: path.join(basePathProfile.storageRootDir, projectNamespace),
	};
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
			[
				'Human-authored agent-vm system config. Comments are allowed here; runtime effective files stay strict JSON.',
				'Controller SSH adminAccess defaults to mode: "none" because secret-backed admin SSH needs a real operator-created secret.',
				'To enable controller-mediated SSH, create the secret first, then change zones[].adminAccess to { "mode": "secret", "secret": { ... } }.',
			].join('\n'),
			defaultSystemConfig(
				options.zoneId,
				gatewayType,
				projectNamespace,
				options.secretsProvider,
				configWritablePathProfile,
				options.onePasswordKeychainAccountName,
				options.agents,
			),
		),
		overwrite,
	);
	(systemConfigStatus === 'created' ? created : skipped).push(systemConfigRelativePath);
	await writeConfigSchemaArtifacts({
		configDir,
		created,
		overwrite,
		skipped,
		targetDir: options.targetDir,
	});

	if (options.writeLocalEnvironmentFile) {
		const envFilePath = path.join(options.targetDir, '.env.local');
		const envFileStatus = await writeFileIfMissing(
			envFilePath,
			defaultEnvTemplate(gatewayType, options.secretsProvider, options.zoneId, options.agents),
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
		renderHermesManagedConfiguration(),
		overwrite,
	);
	(configStatus === 'created' ? created : skipped).push(
		`config/gateways/${options.zoneId}/${configFileName}`,
	);
	{
		const mcpConfigPath = path.join(
			options.targetDir,
			'config',
			'gateways',
			options.zoneId,
			'mcp.config.jsonc',
		);
		const mcpConfigStatus = await writeFileIfMissing(
			mcpConfigPath,
			formatJsoncConfig(
				'Human-authored upstream MCP provider catalog for the MCP Portal.',
				defaultMcpProviderConfig(),
			),
			overwrite,
		);
		(mcpConfigStatus === 'created' ? created : skipped).push(
			`config/gateways/${options.zoneId}/mcp.config.jsonc`,
		);

		const toolPortalConfigPath = path.join(
			options.targetDir,
			'config',
			'gateways',
			options.zoneId,
			'tool-portal.config.jsonc',
		);
		const toolPortalConfigStatus = await writeFileIfMissing(
			toolPortalConfigPath,
			formatJsoncConfig(
				'Human-authored managed Tool Portal agent/profile and backend policy config.',
				defaultToolPortalConfig(options.agents),
			),
			overwrite,
		);
		(toolPortalConfigStatus === 'created' ? created : skipped).push(
			`config/gateways/${options.zoneId}/tool-portal.config.jsonc`,
		);
	}
	{
		const gatewayDockerfilePath = path.join(
			options.targetDir,
			'vm-images',
			'gateways',
			gatewayType,
			'Dockerfile',
		);
		const gatewayDockerfileStatus = await writeFileIfMissing(
			gatewayDockerfilePath,
			hermesImageRecipe.dockerfile,
			overwrite,
		);
		(gatewayDockerfileStatus === 'created' ? created : skipped).push(
			`vm-images/gateways/${gatewayType}/Dockerfile`,
		);
	}

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
			hermesImageRecipe.buildConfig,
		),
		overwrite,
	);
	(gatewayBuildConfigStatus === 'created' ? created : skipped).push(
		`vm-images/gateways/${gatewayType}/build-config.jsonc`,
	);
	{
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
			dependencies.resolveManagedVmMinimumZigVersion ?? resolveManagedVmMinimumZigVersion;
		const zigVersion = await resolveZigVersion();
		const managedVmBackendPackageSpec = await resolveManagedVmBackendPackageSpec();
		const vmHostSystemFiles = [
			[
				'Dockerfile',
				renderVmHostSystemDockerfile({
					managedVmBackendPackageSpec,
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
		const storageRootDir = resolveConfigPath(pathProfile.storageRootDir, configDir, homeDir);
		const zoneRootDir = path.join(storageRootDir, options.zoneId);
		const directoriesToCreate = [
			sharedImageCacheDirForStorageRoot(storageRootDir),
			deploymentGeneratedDirForStorageRoot(storageRootDir),
			path.join(storageRootDir, 'controller-state'),
			path.join(storageRootDir, 'controller-runtime'),
			path.join(zoneRootDir, 'state'),
			path.join(zoneRootDir, 'runtime'),
			...(gatewayType === 'hermes' ? [path.join(zoneRootDir, 'zone-files')] : []),
			resolveConfigPath(pathProfile.gatewayBackupDir(options.zoneId), configDir, homeDir),
		];
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
	const keychainTarget =
		dependencies.account !== undefined || dependencies.service !== undefined
			? {
					...(dependencies.account === undefined ? {} : { account: dependencies.account }),
					...(dependencies.service === undefined ? {} : { service: dependencies.service }),
				}
			: dependencies.accountName === undefined
				? {}
				: { accountName: dependencies.accountName };
	const hasToken = dependencies.hasKeychainToken ?? (() => hasServiceAccountToken(keychainTarget));
	const storeToken =
		dependencies.storeKeychainToken ??
		((token: string) => storeServiceAccountToken(token, keychainTarget));

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
