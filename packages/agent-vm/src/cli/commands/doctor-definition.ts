import { object } from '@optique/core/constructs';
import { map } from '@optique/core/modifiers';
import type { Parser } from '@optique/core/parser';
import { command } from '@optique/core/primitives';

import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { runControllerOperationCommand } from '../controller-operation-commands.js';
import { cliDescription } from './command-definition-support.js';
import {
	createConfigOption,
	createPresenceFlag,
	loadSystemConfigFromOption,
} from './command-definition-support.js';

export interface DoctorCommandOptions {
	readonly config: string;
	readonly json: boolean;
	readonly showPassed: boolean;
}

export interface DoctorCommand {
	readonly command: 'doctor';
	readonly options: DoctorCommandOptions;
}

export function createDoctorCommand(): Parser<'sync', DoctorCommand> {
	return command(
		'doctor',
		map(
			object({
				config: createConfigOption(),
				json: createPresenceFlag('--json', 'Print machine-readable JSON output'),
				showPassed: createPresenceFlag(
					'--show-passed',
					'Include passed checks in human-readable output',
				),
			}),
			(options) => ({ command: 'doctor' as const, options }),
		),
		{
			description: cliDescription(
				'Check offline prerequisites for the configured agent-vm project',
			),
		},
	);
}

export async function runDoctorCommand(
	io: CliIo,
	dependencies: CliDependencies,
	options: DoctorCommandOptions,
): Promise<void> {
	await runControllerOperationCommand({
		dependencies,
		io,
		restArguments: [
			options.json ? '--json' : undefined,
			options.showPassed ? '--show-passed' : undefined,
		].filter((argument): argument is string => argument !== undefined),
		subcommand: 'doctor',
		systemConfig: await loadSystemConfigFromOption(options.config, dependencies),
		...(dependencies.collectControllerDoctorEnvironment
			? { collectDoctorEnvironment: dependencies.collectControllerDoctorEnvironment }
			: {}),
		...(dependencies.collectDynamicDoctorChecks
			? { collectDynamicDoctorChecks: dependencies.collectDynamicDoctorChecks }
			: {}),
	});
}
