// oxlint-disable typescript-eslint/explicit-function-return-type
import { command } from 'cmd-ts';

import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { runControllerOperationCommand } from '../controller-operation-commands.js';
import { createConfigOption, loadSystemConfigFromOption } from './command-definition-support.js';

export function createDoctorCommand(io: CliIo, dependencies: CliDependencies) {
	return command({
		name: 'doctor',
		description: 'Check offline prerequisites for the configured agent-vm project',
		args: {
			config: createConfigOption(),
		},
		handler: async ({ config }) => {
			await runControllerOperationCommand({
				dependencies,
				io,
				restArguments: [],
				subcommand: 'doctor',
				systemConfig: await loadSystemConfigFromOption(config, dependencies),
			});
		},
	});
}
