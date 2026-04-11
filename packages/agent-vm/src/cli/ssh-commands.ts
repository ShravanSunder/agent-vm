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

export async function runSshCommand(options: RunSshCommandOptions): Promise<void> {
	const controllerClient = options.dependencies.createControllerClient({
		baseUrl: resolveControllerBaseUrl(options.systemConfig),
	});
	const sshResponse = await controllerClient.enableZoneSsh(
		resolveZoneId(options.systemConfig, options.restArguments),
	);
	const sshInfo = sshResponse as { command?: string };

	if (sshInfo.command) {
		options.io.stdout.write(`${sshInfo.command}\n`);
		return;
	}

	writeJson(options.io, sshResponse);
}
