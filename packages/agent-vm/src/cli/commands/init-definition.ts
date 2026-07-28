// oxlint-disable typescript-eslint/explicit-function-return-type
import { command, flag, oneOf, option, optional, positional, string, type Type } from 'cmd-ts';

import { agentIdSchema, loadSystemConfig } from '../../config/system-config.js';
import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import {
	imageArchitectureSchema,
	promptAndStoreServiceAccountToken,
	resolveScaffoldSystemConfigPath,
	scaffoldAgentVmProject,
	secretsProviderSchema,
	type HostSystemType,
	type ImageArchitecture,
	type ScaffoldPathMode,
	type SecretsProvider,
} from '../init-command.js';
import { parseGatewayType } from './command-definition-support.js';

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
const initPresetNameSet = new Set<string>(initPresetNames);

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

const presetType: Type<string, InitPresetDefaults> = {
	displayName: 'preset-name',
	description: initPresetDescription,
	async from(value) {
		if (!isInitPresetName(value)) {
			throw new Error(`Unknown preset '${value}'. Available: ${initPresetNames.join(', ')}.`);
		}
		return initPresets[value];
	},
};

function isInitPresetName(value: string): value is InitPresetName {
	return initPresetNameSet.has(value);
}

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
	const parsedAgentIds = agentIds
		.split(',')
		.map((agentId) => agentId.trim())
		.filter((agentId) => agentId.length > 0);
	if (parsedAgentIds.length === 0) {
		throw new Error('--openclaw-agents must include at least one non-empty agent id.');
	}
	for (const agentId of parsedAgentIds) {
		const parsedAgentId = agentIdSchema.safeParse(agentId);
		if (!parsedAgentId.success) {
			throw new Error(
				`Invalid --openclaw-agents value '${agentId}': ${parsedAgentId.error.issues[0]?.message ?? 'invalid agent id'}`,
			);
		}
	}
	return Array.from(new Set(parsedAgentIds));
}

export function createInitCommand(io: CliIo, dependencies: CliDependencies) {
	return command({
		name: 'init',
		description: 'Scaffold a new agent-vm project',
		args: {
			zoneId: positional({
				displayName: 'zone-id',
				type: optional(string),
				description: 'Zone identifier (default: "default")',
			}),
			type: option({
				type: string,
				long: 'type',
				description: 'Gateway type: openclaw or worker',
			}),
			preset: option({
				type: optional(presetType),
				long: 'preset',
				description: `Preset group. ${initPresetDescription}`,
			}),
			secrets: option({
				type: optional(oneOf(secretsProviderSchema.options)),
				long: 'secrets',
				description:
					'Secrets provider: 1password (local dev) or environment (CI, container, shell)',
			}),
			arch: option({
				type: optional(oneOf(imageArchitectureSchema.options)),
				long: 'arch',
				description: 'VM image architecture: aarch64 or x86_64',
			}),
			paths: option({
				type: optional(oneOf(scaffoldPathModes)),
				long: 'paths',
				description:
					'Path profile to scaffold: local (sibling-of-config), pod (/var/agent-vm/<projectNamespace>), ' +
					'or user-dir (~/.agent-vm/<projectNamespace>). Every profile scopes storageRootDir by projectNamespace. Defaults from preset.',
			}),
			namespace: option({
				type: optional(string),
				long: 'namespace',
				description:
					'Project namespace override (default: deterministic namespace from target path)',
			}),
			overwrite: flag({
				long: 'overwrite',
				description: 'Overwrite existing scaffolded files (default: skip existing files)',
			}),
			agents: option({
				type: optional(string),
				long: 'openclaw-agents',
				description:
					'Single OpenClaw agent id to scaffold during the Socket.IO control-plane hard cutover.',
			}),
			onePasswordKeychainAccountName: option({
				type: optional(string),
				long: 'onepassword-keychain-account-name',
				description:
					'Keychain account suffix for the 1Password service account token, stored as 1p-service-account--<name>.',
			}),
		},
		handler: async ({
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
		}) => {
			const gatewayType = parseGatewayType(type);
			const presetDefaults = preset;
			const secretsProvider = resolveSecretsProvider(secrets, presetDefaults);
			const architecture = resolveArchitecture(arch, presetDefaults);
			const pathMode = resolvePathMode(paths, presetDefaults);
			const hostSystemType = resolveHostSystemType(pathMode, presetDefaults);
			const targetDir = dependencies.getCurrentWorkingDirectory?.() ?? process.cwd();
			const result = await (dependencies.scaffoldAgentVmProject ?? scaffoldAgentVmProject)({
				...(agents === undefined ? {} : { agents: parseAgentIds(agents) }),
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
					? await (
							dependencies.promptAndStoreServiceAccountToken ?? promptAndStoreServiceAccountToken
						)(
							await resolveOnePasswordPromptOptions({
								accountName: onePasswordKeychainAccountName,
								targetDir,
							}),
						)
					: false;
			io.stdout.write(`${JSON.stringify({ ...result, keychainStored }, null, 2)}\n`);
		},
	});
}
