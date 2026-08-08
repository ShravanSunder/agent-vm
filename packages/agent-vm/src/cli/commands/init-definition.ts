import { object } from '@optique/core/constructs';
import { map, optional } from '@optique/core/modifiers';
import type { Parser } from '@optique/core/parser';
import { argument, command, option } from '@optique/core/primitives';
import { zod } from '@optique/zod';
import { z } from 'zod';

import {
	agentIdSchema,
	loadSystemConfig,
	projectNamespaceSchema,
	zoneIdSchema,
} from '../../config/system-config.js';
import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import {
	imageArchitectureSchema,
	promptAndStoreServiceAccountToken,
	resolveScaffoldSystemConfigPath,
	scaffoldAgentVmProject,
	secretsProviderSchema,
	type HostSystemType,
	type GatewayType,
	type ImageArchitecture,
	type ScaffoldPathMode,
	type SecretsProvider,
} from '../init-command.js';
import { cliDescription, createPresenceFlag } from './command-definition-support.js';

export interface InitPresetDefaults {
	readonly architecture: ImageArchitecture;
	readonly hostSystemType: HostSystemType;
	readonly paths: ScaffoldPathMode;
	readonly secretsProvider: SecretsProvider;
	readonly writeLocalEnvironmentFile: boolean;
}

const scaffoldPathModes = [
	'local',
	'pod',
	'user-dir',
] as const satisfies readonly ScaffoldPathMode[];
const initPresetNames = ['macos-local', 'container-x86', 'container-arm64'] as const;
type InitPresetName = (typeof initPresetNames)[number];

const initPresets = {
	'macos-local': {
		architecture: 'aarch64',
		hostSystemType: 'bare-metal',
		paths: 'user-dir',
		secretsProvider: '1password',
		writeLocalEnvironmentFile: true,
	},
	'container-x86': {
		architecture: 'x86_64',
		hostSystemType: 'container',
		paths: 'pod',
		secretsProvider: 'environment',
		writeLocalEnvironmentFile: false,
	},
	'container-arm64': {
		architecture: 'aarch64',
		hostSystemType: 'container',
		paths: 'pod',
		secretsProvider: 'environment',
		writeLocalEnvironmentFile: false,
	},
} as const satisfies Record<InitPresetName, InitPresetDefaults>;

const initPresetDescription =
	'macos-local: user-dir paths (storageRootDir ~/.agent-vm/<projectNamespace> with derived global and zone paths, ' +
	'backupDir ~/.agent-vm-backups/<zone>), aarch64, 1password, .env.local; ' +
	'container-x86: container runtime paths (/var/agent-vm/<projectNamespace>), x86_64, environment secrets; ' +
	'container-arm64: container runtime paths (/var/agent-vm/<projectNamespace>), aarch64, environment secrets';

const initPresetSchema = z.enum(initPresetNames).transform((value) => initPresets[value]);
const gatewayTypeSchema = z.enum(['openclaw', 'worker']);
const scaffoldPathModeSchema = z.enum(scaffoldPathModes);
const openClawAgentsSchema = z
	.string()
	.transform((value) =>
		value
			.split(',')
			.map((agentId) => agentId.trim())
			.filter((agentId) => agentId.length > 0),
	)
	.superRefine((agentIds, context) => {
		if (agentIds.length === 0) {
			context.addIssue({
				code: 'custom',
				message: '--openclaw-agents must include at least one non-empty agent id.',
			});
			return;
		}
		for (const agentId of agentIds) {
			const parsedAgentId = agentIdSchema.safeParse(agentId);
			if (!parsedAgentId.success) {
				context.addIssue({
					code: 'custom',
					message: `Invalid --openclaw-agents value '${agentId}': ${parsedAgentId.error.issues[0]?.message ?? 'invalid agent id'}`,
				});
			}
		}
	})
	.transform((agentIds) => Array.from(new Set(agentIds)));

function resolveSecretsProvider(
	secrets: SecretsProvider | undefined,
	preset: InitPresetDefaults | undefined,
): SecretsProvider {
	if (secrets) {
		return secrets;
	}
	if (preset) {
		return preset.secretsProvider;
	}
	throw new Error(
		`Secrets provider is required. Expected one of: ${secretsProviderSchema.options.join(', ')}.`,
	);
}

function resolveArchitecture(
	architecture: ImageArchitecture | undefined,
	preset: InitPresetDefaults | undefined,
): ImageArchitecture {
	if (architecture) {
		return architecture;
	}
	if (preset) {
		return preset.architecture;
	}
	throw new Error(
		`Architecture is required. Expected one of: ${imageArchitectureSchema.options.join(', ')}.`,
	);
}

function resolvePathMode(
	paths: ScaffoldPathMode | undefined,
	preset: InitPresetDefaults | undefined,
): ScaffoldPathMode {
	return paths ?? preset?.paths ?? 'local';
}

function resolveHostSystemType(
	paths: ScaffoldPathMode,
	preset: InitPresetDefaults | undefined,
): HostSystemType {
	return preset?.hostSystemType ?? (paths === 'pod' ? 'container' : 'bare-metal');
}

async function resolveOnePasswordPromptOptions(options: {
	readonly accountName: string | undefined;
	readonly targetDir: string;
}): Promise<{
	readonly account?: string;
	readonly accountName?: string;
	readonly service?: string;
}> {
	try {
		const systemConfigPath = await resolveScaffoldSystemConfigPath(`${options.targetDir}/config`);
		const systemConfig = await loadSystemConfig(systemConfigPath);
		const secretsProvider = systemConfig.host.secretsProvider;
		if (secretsProvider?.type === '1password' && secretsProvider.tokenSource.type === 'keychain') {
			return {
				account: secretsProvider.tokenSource.account,
				service: secretsProvider.tokenSource.service,
			};
		}
	} catch (error) {
		if (
			!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
		) {
			throw error;
		}
	}
	return options.accountName === undefined ? {} : { accountName: options.accountName };
}

export function parseAgentIds(agentIds: string): readonly string[] {
	const parsedAgentIds = openClawAgentsSchema.safeParse(agentIds);
	if (!parsedAgentIds.success) {
		throw new Error(parsedAgentIds.error.issues[0]?.message ?? 'Invalid --openclaw-agents value.');
	}
	return parsedAgentIds.data;
}

export interface InitCommandOptions {
	readonly zoneId: string | undefined;
	readonly type: GatewayType;
	readonly preset: InitPresetDefaults | undefined;
	readonly secrets: SecretsProvider | undefined;
	readonly arch: ImageArchitecture | undefined;
	readonly paths: ScaffoldPathMode | undefined;
	readonly namespace: string | undefined;
	readonly overwrite: boolean;
	readonly agents: readonly string[] | undefined;
	readonly onePasswordKeychainAccountName: string | undefined;
}

export interface InitCommand {
	readonly command: 'init';
	readonly options: InitCommandOptions;
}

export function createInitCommand(): Parser<'sync', InitCommand> {
	return command(
		'init',
		map(
			object({
				zoneId: optional(
					argument(zod(zoneIdSchema, { metavar: 'ZONE_ID', placeholder: 'default' }), {
						description: cliDescription('Zone identifier (default: "default")'),
					}),
				),
				type: option(
					'--type',
					zod<GatewayType>(gatewayTypeSchema, {
						metavar: 'TYPE',
						placeholder: 'openclaw',
						errors: {
							zodError: (_error, input) =>
								cliDescription(
									`Gateway type is required. Expected 'openclaw' or 'worker', got '${input}'.`,
								),
						},
					}),
					{ description: cliDescription('Gateway type: openclaw or worker') },
				),
				preset: optional(
					option(
						'--preset',
						zod<InitPresetDefaults>(initPresetSchema, {
							metavar: 'PRESET',
							placeholder: initPresets['macos-local'],
						}),
						{ description: cliDescription(`Preset group. ${initPresetDescription}`) },
					),
				),
				secrets: optional(
					option(
						'--secrets',
						zod<SecretsProvider>(secretsProviderSchema, {
							metavar: 'PROVIDER',
							placeholder: 'environment',
						}),
						{
							description: cliDescription(
								'Secrets provider: 1password (local dev) or environment (CI, container, shell)',
							),
						},
					),
				),
				arch: optional(
					option(
						'--arch',
						zod<ImageArchitecture>(imageArchitectureSchema, {
							metavar: 'ARCH',
							placeholder: 'aarch64',
						}),
						{ description: cliDescription('VM image architecture: aarch64 or x86_64') },
					),
				),
				paths: optional(
					option(
						'--paths',
						zod<ScaffoldPathMode>(scaffoldPathModeSchema, {
							metavar: 'PATHS',
							placeholder: 'local',
						}),
						{
							description: cliDescription(
								'Path profile to scaffold: local (sibling-of-config), pod (/var/agent-vm/<projectNamespace>), or user-dir (~/.agent-vm/<projectNamespace>). Every profile scopes storageRootDir by projectNamespace. Defaults from preset.',
							),
						},
					),
				),
				namespace: optional(
					option(
						'--namespace',
						zod(projectNamespaceSchema, { metavar: 'NAMESPACE', placeholder: 'project' }),
						{
							description: cliDescription(
								'Project namespace override (default: deterministic namespace from target path)',
							),
						},
					),
				),
				overwrite: createPresenceFlag(
					'--overwrite',
					'Overwrite existing scaffolded files (default: skip existing files)',
				),
				agents: optional(
					option(
						'--openclaw-agents',
						zod(openClawAgentsSchema, { metavar: 'AGENTS', placeholder: ['main'] }),
						{
							description: cliDescription(
								'Single OpenClaw agent id to scaffold during the Socket.IO control-plane hard cutover.',
							),
						},
					),
				),
				onePasswordKeychainAccountName: optional(
					option(
						'--onepassword-keychain-account-name',
						zod(z.string(), { metavar: 'ACCOUNT', placeholder: 'account' }),
						{
							description: cliDescription(
								'Keychain account suffix for the 1Password service account token, stored as 1p-service-account--<name>.',
							),
						},
					),
				),
			}),
			(options) => ({ command: 'init' as const, options }),
		),
		{ description: cliDescription('Scaffold a new agent-vm project') },
	);
}

export async function runInitCommand(
	io: CliIo,
	dependencies: CliDependencies,
	options: InitCommandOptions,
): Promise<void> {
	const {
		agents,
		arch,
		namespace,
		onePasswordKeychainAccountName,
		overwrite,
		paths,
		preset,
		secrets,
		type,
		zoneId,
	} = options;
	const gatewayType = type;
	const presetDefaults = preset;
	const secretsProvider = resolveSecretsProvider(secrets, presetDefaults);
	const architecture = resolveArchitecture(arch, presetDefaults);
	const pathMode = resolvePathMode(paths, presetDefaults);
	const hostSystemType = resolveHostSystemType(pathMode, presetDefaults);
	const targetDir = dependencies.getCurrentWorkingDirectory?.() ?? process.cwd();
	const result = await (dependencies.scaffoldAgentVmProject ?? scaffoldAgentVmProject)({
		...(agents === undefined ? {} : { agents }),
		architecture,
		gatewayType,
		hostSystemType,
		...(onePasswordKeychainAccountName === undefined ? {} : { onePasswordKeychainAccountName }),
		overwrite,
		paths: pathMode,
		...(namespace === undefined ? {} : { projectNamespace: namespace }),
		secretsProvider,
		targetDir,
		writeLocalEnvironmentFile: presetDefaults?.writeLocalEnvironmentFile ?? false,
		zoneId: zoneId ?? 'default',
	});
	const keychainStored =
		secretsProvider === '1password'
			? await (dependencies.promptAndStoreServiceAccountToken ?? promptAndStoreServiceAccountToken)(
					await resolveOnePasswordPromptOptions({
						accountName: onePasswordKeychainAccountName,
						targetDir,
					}),
				)
			: false;
	io.stdout.write(`${JSON.stringify({ ...result, keychainStored }, null, 2)}\n`);
}
