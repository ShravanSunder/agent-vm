// oxlint-disable typescript-eslint/explicit-function-return-type
import { command, flag } from 'cmd-ts';

import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { runControllerOperationCommand } from '../controller-operation-commands.js';
import { createConfigOption, loadSystemConfigFromOption } from './command-definition-support.js';

export function createDoctorCommand(io: CliIo, dependencies: CliDependencies) {
	return command({
		name: 'doctor',
		description: 'Check offline prerequisites for the configured agent-vm project',
		args: {
			config: createConfigOption(),
			json: flag({
				long: 'json',
				description: 'Print machine-readable JSON output',
			}),
			showPassed: flag({
				long: 'show-passed',
				description: 'Include passed checks in human-readable output',
			}),
		},
		handler: async ({ config, json, showPassed }) => {
			await runControllerOperationCommand({
				dependencies,
				io,
				restArguments: [
					json ? '--json' : undefined,
					showPassed ? '--show-passed' : undefined,
				].filter((argument): argument is string => argument !== undefined),
				subcommand: 'doctor',
				systemConfig: await loadSystemConfigFromOption(config, dependencies),
				...(dependencies.collectControllerDoctorEnvironment
					? { collectDoctorEnvironment: dependencies.collectControllerDoctorEnvironment }
					: {}),
				...(dependencies.collectDynamicDoctorChecks
					? { collectDynamicDoctorChecks: dependencies.collectDynamicDoctorChecks }
					: {}),
			});
		},
	});
}
