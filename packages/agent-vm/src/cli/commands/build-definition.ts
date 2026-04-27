// oxlint-disable typescript-eslint/explicit-function-return-type
import { command, flag } from 'cmd-ts';

import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { runBuildCommand } from '../build-command.js';
import { createPlainRunTask } from '../run-task.js';
import { createConfigOption, loadSystemConfigFromOption } from './command-definition-support.js';

export function createBuildCommand(_io: CliIo, dependencies: CliDependencies) {
	return command({
		name: 'build',
		description: 'Build Docker OCI images and Gondolin VM assets',
		args: {
			config: createConfigOption(),
			force: flag({
				long: 'force',
				description: 'Force rebuild, ignoring cache',
			}),
		},
		handler: async ({ config, force }) => {
			const systemConfig = await loadSystemConfigFromOption(config, dependencies);
			const runTask = createPlainRunTask(_io);
			await (dependencies.runBuildCommand ?? runBuildCommand)(
				{
					forceRebuild: force,
					systemConfig,
				},
				{ runTask },
			);
		},
	});
}
