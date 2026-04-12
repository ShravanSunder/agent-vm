// oxlint-disable typescript-eslint/explicit-function-return-type
import { command, subcommands } from 'cmd-ts';

import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { runCacheCommand } from '../cache-commands.js';
import {
	createConfigOption,
	createConfirmFlag,
	loadSystemConfigFromOption,
} from './command-definition-support.js';

export function createCacheSubcommands(io: CliIo, dependencies: CliDependencies) {
	return subcommands({
		name: 'cache',
		description: 'Manage image cache state',
		cmds: {
			list: command({
				name: 'list',
				description: 'List gateway/tool cache entries',
				args: {
					config: createConfigOption(),
				},
				handler: async ({ config }) => {
					await (dependencies.runCacheCommand ?? runCacheCommand)(
						{
							subcommand: 'list',
							systemConfig: loadSystemConfigFromOption(config, dependencies),
						},
						io,
					);
				},
			}),
			clean: command({
				name: 'clean',
				description: 'Delete stale cache entries',
				args: {
					config: createConfigOption(),
					confirm: createConfirmFlag(),
				},
				handler: async ({ config, confirm }) => {
					await (dependencies.runCacheCommand ?? runCacheCommand)(
						{
							confirm,
							subcommand: 'clean',
							systemConfig: loadSystemConfigFromOption(config, dependencies),
						},
						io,
					);
				},
			}),
		},
	});
}
