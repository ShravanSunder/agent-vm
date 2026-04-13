import type { GatewayAuthConfig } from '@shravansunder/agent-vm-gateway-interface';
import { execa } from 'execa';

import type { SystemConfig } from '../config/system-config.js';
import {
	type CliDependencies,
	type CliIo,
	resolveControllerBaseUrl,
} from './agent-vm-cli-support.js';
import { zoneSshAccessResponseSchema, type ZoneSshAccessResponse } from './ssh-commands.js';

const openClawShellEnvFilePath = '/etc/profile.d/openclaw-env.sh';

function shellQuote(value: string): string {
	return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function wrapWithOpenClawShellEnvironment(command: string): string {
	return `bash -lc ${shellQuote(`source ${openClawShellEnvFilePath} && ${command}`)}`;
}

export async function listAuthProviders(options: {
	readonly listProvidersCommand: string;
	readonly runCommand?: (
		command: string,
		arguments_: readonly string[],
	) => Promise<{ readonly exitCode: number; readonly stderr: string; readonly stdout: string }>;
	readonly sshAccess: ZoneSshAccessResponse;
}): Promise<readonly string[]> {
	if (!options.sshAccess.host || !options.sshAccess.port) {
		throw new Error('Cannot list auth providers: controller returned incomplete SSH access.');
	}

	const runCommand =
		options.runCommand ??
		(async (
			command: string,
			arguments_: readonly string[],
		): Promise<{ readonly exitCode: number; readonly stderr: string; readonly stdout: string }> => {
			const result = await execa(command, arguments_, { reject: false });
			return {
				exitCode: result.exitCode ?? 0,
				stderr: result.stderr,
				stdout: result.stdout,
			};
		});
	const commandResult = await runCommand('ssh', [
		'-o',
		'StrictHostKeyChecking=no',
		'-o',
		'UserKnownHostsFile=/dev/null',
		...(options.sshAccess.identityFile ? ['-i', options.sshAccess.identityFile] : []),
		'-p',
		String(options.sshAccess.port),
		`${options.sshAccess.user ?? 'root'}@${options.sshAccess.host}`,
		wrapWithOpenClawShellEnvironment(options.listProvidersCommand),
	]);
	if (commandResult.exitCode !== 0) {
		throw new Error(
			`Failed to list auth providers: ${commandResult.stderr || `ssh exited with ${commandResult.exitCode}`}`,
		);
	}

	return commandResult.stdout
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

export async function runAuthInteractiveCommand(options: {
	readonly authConfig: GatewayAuthConfig | undefined;
	readonly dependencies: Pick<
		CliDependencies,
		'createControllerClient' | 'runCommand' | 'runInteractiveProcess'
	>;
	readonly io: CliIo;
	readonly provider: string;
	readonly runCommand?: (
		command: string,
		arguments_: readonly string[],
	) => Promise<{ readonly exitCode: number; readonly stderr: string; readonly stdout: string }>;
	readonly systemConfig: SystemConfig;
	readonly zoneId: string;
}): Promise<void> {
	if (!options.authConfig) {
		throw new Error(`Zone '${options.zoneId}' does not support interactive auth.`);
	}

	const controllerClient = options.dependencies.createControllerClient({
		baseUrl: resolveControllerBaseUrl(options.systemConfig),
	});
	const parsedSshResponse = zoneSshAccessResponseSchema.safeParse(
		await controllerClient.enableZoneSsh(options.zoneId),
	);
	if (!parsedSshResponse.success) {
		throw new Error('Controller returned an invalid SSH response.');
	}

	const sshResponse = parsedSshResponse.data;
	if (!sshResponse.host || !sshResponse.port) {
		throw new Error(
			`Cannot auth: controller returned incomplete SSH access for zone '${options.zoneId}'.`,
		);
	}

	const sshArguments = [
		'-t',
		'-o',
		'StrictHostKeyChecking=no',
		'-o',
		'UserKnownHostsFile=/dev/null',
		...(sshResponse.identityFile ? ['-i', sshResponse.identityFile] : []),
		'-p',
		String(sshResponse.port),
		`${sshResponse.user ?? 'root'}@${sshResponse.host}`,
		wrapWithOpenClawShellEnvironment(options.authConfig.buildLoginCommand(options.provider)),
	];

	const runInteractiveProcess =
		options.dependencies.runInteractiveProcess ??
		(async (command: string, arguments_: readonly string[]): Promise<void> => {
			await execa(command, arguments_, {
				stdio: 'inherit',
			});
		});

	try {
		await runInteractiveProcess('ssh', sshArguments);
	} catch (error) {
		throw new Error(
			`Auth failed for ${options.provider} in zone '${options.zoneId}': ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}
