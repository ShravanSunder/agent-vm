// oxlint-disable typescript-eslint/explicit-function-return-type
import { command } from 'cmd-ts';

import { runConfigValidation } from '../../operations/config-validation.js';
import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { writeJson } from '../agent-vm-cli-support.js';
import { createConfigOption, loadSystemConfigFromOption } from './command-definition-support.js';

export function createValidateCommand(io: CliIo, dependencies: CliDependencies) {
	return command({
		name: 'validate',
		description: 'Validate agent-vm config files without checking host readiness',
		args: {
			config: createConfigOption(),
		},
		handler: async ({ config }) => {
			writeJson(
				io,
				await (dependencies.runConfigValidation ?? runConfigValidation)({
					...(dependencies.runCommand ? { runCommand: dependencies.runCommand } : {}),
					systemConfig: await loadSystemConfigFromOption(config, dependencies),
				}),
			);
		},
	});
}
