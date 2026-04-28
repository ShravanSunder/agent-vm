// oxlint-disable typescript-eslint/explicit-function-return-type
import { command, flag, oneOf, option, optional, positional, string, type Type } from 'cmd-ts';

import type { HostSystemType } from '../../config/system-cache-identifier.js';
import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import {
	imageArchitectureSchema,
	promptAndStoreServiceAccountToken,
	scaffoldAgentVmProject,
	secretsProviderSchema,
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
const initPresetNames = ['macos-local', 'container-x86'] as const;
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
} as const satisfies Record<InitPresetName, InitPresetDefaults>;

const initPresetDescription =
	'macos-local: user-dir paths (cacheDir ~/.agent-vm/cache, runtimeDir ~/.agent-vm/runtime, ' +
	'stateDir ~/.agent-vm/state/<zone>, zoneFilesDir ~/.agent-vm/zone-files/<zone>, ' +
	'backupDir ~/.agent-vm-backups/<zone>), aarch64, 1password, .env.local; ' +
	'container-x86: container runtime paths (/var/agent-vm), x86_64, environment secrets';

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
					'Path profile to scaffold: local (sibling-of-config), pod (/var/agent-vm), ' +
					'or user-dir (~/.agent-vm). Defaults from preset.',
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
		},
		handler: async ({ arch, namespace, overwrite, paths, preset, secrets, type, zoneId }) => {
			const gatewayType = parseGatewayType(type);
			const presetDefaults = preset;
			const secretsProvider = resolveSecretsProvider(secrets, presetDefaults);
			const architecture = resolveArchitecture(arch, presetDefaults);
			const pathMode = resolvePathMode(paths, presetDefaults);
			const hostSystemType = resolveHostSystemType(pathMode, presetDefaults);
			const result = await (dependencies.scaffoldAgentVmProject ?? scaffoldAgentVmProject)({
				architecture,
				gatewayType,
				hostSystemType,
				overwrite,
				paths: pathMode,
				...(namespace === undefined ? {} : { projectNamespace: namespace }),
				secretsProvider,
				targetDir: dependencies.getCurrentWorkingDirectory?.() ?? process.cwd(),
				writeLocalEnvironmentFile: presetDefaults?.writeLocalEnvironmentFile ?? false,
				zoneId: zoneId ?? 'default',
			});
			const keychainStored =
				secretsProvider === '1password'
					? await (
							dependencies.promptAndStoreServiceAccountToken ?? promptAndStoreServiceAccountToken
						)()
					: false;
			io.stdout.write(`${JSON.stringify({ ...result, keychainStored }, null, 2)}\n`);
		},
	});
}
