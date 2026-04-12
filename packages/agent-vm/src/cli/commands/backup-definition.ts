// oxlint-disable typescript-eslint/explicit-function-return-type
import { command, positional, string, subcommands } from 'cmd-ts';

import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { runBackupCommand } from '../backup-commands.js';
import {
	appendZoneArgument,
	createConfigOption,
	createZoneOption,
	loadSystemConfigFromOption,
} from './command-definition-support.js';

export function createBackupSubcommands(io: CliIo, dependencies: CliDependencies) {
	return subcommands({
		name: 'backup',
		description: 'Manage encrypted zone backups',
		cmds: {
			create: command({
				name: 'create',
				description: 'Create a zone backup',
				args: {
					config: createConfigOption(),
					zone: createZoneOption(),
				},
				handler: async ({ config, zone }) => {
					await runBackupCommand({
						dependencies,
						io,
						restArguments: appendZoneArgument(['create'], zone),
						systemConfig: await loadSystemConfigFromOption(config, dependencies),
					});
				},
			}),
			list: command({
				name: 'list',
				description: 'List backups for a zone',
				args: {
					config: createConfigOption(),
					zone: createZoneOption(),
				},
				handler: async ({ config, zone }) => {
					await runBackupCommand({
						dependencies,
						io,
						restArguments: appendZoneArgument(['list'], zone),
						systemConfig: await loadSystemConfigFromOption(config, dependencies),
					});
				},
			}),
			restore: command({
				name: 'restore',
				description: 'Restore a backup into a zone',
				args: {
					backupPath: positional({
						displayName: 'path',
						type: string,
						description: 'Path to the encrypted backup file',
					}),
					config: createConfigOption(),
					zone: createZoneOption(),
				},
				handler: async ({ backupPath, config, zone }) => {
					await runBackupCommand({
						dependencies,
						io,
						restArguments: appendZoneArgument(['restore', backupPath], zone),
						systemConfig: await loadSystemConfigFromOption(config, dependencies),
					});
				},
			}),
		},
	});
}
