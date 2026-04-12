import { execa } from 'execa';
import { z } from 'zod';

import type { SystemConfig } from '../config/system-config.js';
import {
	type CliDependencies,
	type CliIo,
	resolveControllerBaseUrl,
	resolveZoneId,
} from './agent-vm-cli-support.js';

interface RunSshCommandOptions {
	readonly dependencies: CliDependencies;
	readonly io: CliIo;
	readonly restArguments: readonly string[];
	readonly systemConfig: SystemConfig;
}

export const zoneSshAccessResponseSchema = z
	.object({
		command: z.string().min(1).optional(),
		host: z.string().min(1).optional(),
		identityFile: z.string().min(1).optional(),
		port: z.number().int().positive().optional(),
		user: z.string().min(1).optional(),
	})
	.passthrough();

export type ZoneSshAccessResponse = z.infer<typeof zoneSshAccessResponseSchema>;

export async function runSshCommand(options: RunSshCommandOptions): Promise<void> {
	const controllerClient = options.dependencies.createControllerClient({
		baseUrl: resolveControllerBaseUrl(options.systemConfig),
	});
	const parsedSshResponse = zoneSshAccessResponseSchema.safeParse(
		await controllerClient.enableZoneSsh(
			resolveZoneId(options.systemConfig, options.restArguments),
		),
	);
	if (!parsedSshResponse.success) {
		throw new Error('Controller returned an invalid SSH response.');
	}
	const sshResponse: ZoneSshAccessResponse = parsedSshResponse.data;
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

		throw new Error(
			'Controller returned incomplete SSH access details. Re-run with --print if you expect a raw SSH command.',
		);
	}

	const sshArguments = [
		'-o',
		'StrictHostKeyChecking=no',
		'-o',
		'UserKnownHostsFile=/dev/null',
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
	try {
		await runInteractiveProcess('ssh', sshArguments);
	} catch (error) {
		throw new Error(
			`Failed to open SSH session to ${sshResponse.user ?? 'root'}@${sshResponse.host}:${sshResponse.port}: ${error instanceof Error ? error.message : String(error)}`,
			{
				cause: error,
			},
		);
	}
}
