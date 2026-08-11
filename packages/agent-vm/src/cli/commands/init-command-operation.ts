import { loadSystemConfig } from '../../config/system-config.js';
import { type CliDependencies, type CliIo } from '../agent-vm-cli-support.js';
import type { AgentVmCommand } from '../agent-vm-command-parser.js';
import {
	imageArchitectureSchema,
	promptAndStoreServiceAccountToken,
	resolveScaffoldSystemConfigPath,
	scaffoldAgentVmProject,
	secretsProviderSchema,
} from '../init-command.js';

type InitCommand = Extract<AgentVmCommand, { readonly command: 'init' }>;
type InitOptions = InitCommand['options'];
type Preset = NonNullable<InitOptions['preset']>;

function resolveSecretsProvider(
	value: InitOptions['secrets'],
	preset: InitOptions['preset'],
): NonNullable<InitOptions['secrets']> {
	if (value !== undefined) return value;
	if (preset !== undefined) return preset.secretsProvider;
	throw new Error(
		`Secrets provider is required. Expected one of: ${secretsProviderSchema.options.join(', ')}.`,
	);
}
function resolveArchitecture(
	value: InitOptions['arch'],
	preset: InitOptions['preset'],
): NonNullable<InitOptions['arch']> {
	if (value !== undefined) return value;
	if (preset !== undefined) return preset.architecture;
	throw new Error(
		`Architecture is required. Expected one of: ${imageArchitectureSchema.options.join(', ')}.`,
	);
}
function resolvePathMode(
	value: InitOptions['paths'],
	preset: InitOptions['preset'],
): NonNullable<InitOptions['paths']> {
	return value ?? preset?.paths ?? 'local';
}
async function resolveOnePasswordPromptOptions(
	accountName: string | undefined,
	targetDir: string,
): Promise<{
	readonly account?: string;
	readonly accountName?: string;
	readonly service?: string;
}> {
	try {
		const systemConfig = await loadSystemConfig(
			await resolveScaffoldSystemConfigPath(`${targetDir}/config`),
		);
		const provider = systemConfig.host.secretsProvider;
		if (provider?.type === '1password' && provider.tokenSource.type === 'keychain') {
			return { account: provider.tokenSource.account, service: provider.tokenSource.service };
		}
	} catch (error) {
		if (
			!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
		)
			throw error;
	}
	return accountName === undefined ? {} : { accountName };
}

export async function runInitCommandOperation(
	io: CliIo,
	dependencies: CliDependencies,
	command: InitCommand,
): Promise<void> {
	const options = command.options;
	const preset: Preset | undefined = options.preset;
	const secretsProvider = resolveSecretsProvider(options.secrets, preset);
	const architecture = resolveArchitecture(options.arch, preset);
	const paths = resolvePathMode(options.paths, preset);
	const targetDir = dependencies.getCurrentWorkingDirectory?.() ?? process.cwd();
	const result = await (dependencies.scaffoldAgentVmProject ?? scaffoldAgentVmProject)({
		...(options.agents === undefined ? {} : { agents: options.agents }),
		architecture,
		gatewayType: options.type,
		hostSystemType: preset?.hostSystemType ?? (paths === 'pod' ? 'container' : 'bare-metal'),
		...(options.onePasswordKeychainAccountName === undefined
			? {}
			: { onePasswordKeychainAccountName: options.onePasswordKeychainAccountName }),
		overwrite: options.overwrite,
		paths,
		...(options.namespace === undefined ? {} : { projectNamespace: options.namespace }),
		secretsProvider,
		targetDir,
		writeLocalEnvironmentFile: preset?.writeLocalEnvironmentFile ?? false,
		zoneId: options.zoneId,
	});
	const keychainStored =
		secretsProvider === '1password'
			? await (dependencies.promptAndStoreServiceAccountToken ?? promptAndStoreServiceAccountToken)(
					await resolveOnePasswordPromptOptions(options.onePasswordKeychainAccountName, targetDir),
				)
			: false;
	io.stdout.write(`${JSON.stringify({ ...result, keychainStored }, null, 2)}\n`);
}
