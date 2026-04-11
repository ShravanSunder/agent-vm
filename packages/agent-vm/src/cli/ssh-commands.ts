import { execa } from 'execa';

import type { SystemConfig } from '../controller/system-config.js';
import {
	type CliDependencies,
	type CliIo,
	resolveControllerBaseUrl,
	resolveZoneId,
	writeJson,
} from './agent-vm-cli-support.js';

interface RunSshCommandOptions {
	readonly dependencies: CliDependencies;
	readonly io: CliIo;
	readonly restArguments: readonly string[];
	readonly systemConfig: SystemConfig;
}

interface ZoneSshAccessResponse {
	readonly command?: string;
	readonly host?: string;
	readonly identityFile?: string;
	readonly port?: number;
	readonly user?: string;
}

export async function runSshCommand(options: RunSshCommandOptions): Promise<void> {
	const controllerClient = options.dependencies.createControllerClient({
		baseUrl: resolveControllerBaseUrl(options.systemConfig),
	});
	const sshResponse = (await controllerClient.enableZoneSsh(
		resolveZoneId(options.systemConfig, options.restArguments),
	)) as ZoneSshAccessResponse;
	const printOnly = options.restArguments.includes('--print');
	const commandSeparatorIndex = options.restArguments.indexOf('--');
	const remoteCommandArguments =
		commandSeparatorIndex >= 0 ? options.restArguments.slice(commandSeparatorIndex + 1) : [];

	if (printOnly || !sshResponse.host || !sshResponse.port) {
		if (sshResponse.command) {
			const printedCommand =
				remoteCommandArguments.length > 0
					? `${sshResponse.command} ${remoteCommandArguments.join(' ')}`
					: sshResponse.command;
			options.io.stdout.write(`${printedCommand}\n`);
			return;
		}

		writeJson(options.io, sshResponse);
		return;
	}

	const sshArguments = [
		...(sshResponse.identityFile ? ['-i', sshResponse.identityFile] : []),
		'-p',
		String(sshResponse.port),
		`${sshResponse.user ?? 'root'}@${sshResponse.host}`,
		...remoteCommandArguments,
	];
	const runInteractiveProcess =
		options.dependencies.runInteractiveProcess ??
		(async (command: string, arguments_: readonly string[]): Promise<void> => {
			await execa(command, arguments_, {
				stdio: 'inherit',
			});
		});
	await runInteractiveProcess('ssh', sshArguments);
}
