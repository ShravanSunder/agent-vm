import { execa } from 'execa';

import type { SystemConfig } from '../config/system-config.js';
import {
	type CliDependencies,
	type CliIo,
	resolveControllerBaseUrl,
} from './agent-vm-cli-support.js';
import { zoneSshAccessResponseSchema } from './ssh-commands.js';

export async function runAuthCommand(options: {
	readonly dependencies: CliDependencies;
	readonly io: CliIo;
	readonly pluginName: string;
	readonly systemConfig: SystemConfig;
	readonly zoneId: string;
}): Promise<void> {
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
			`Cannot auth: controller returned incomplete SSH access for zone '${options.zoneId}'. Is the gateway running?`,
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
		'openclaw',
		'models',
		'auth',
		'login',
		'--provider',
		options.pluginName,
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
			`Auth failed for ${options.pluginName} in zone '${options.zoneId}': ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}
