// oxlint-disable typescript-eslint/explicit-function-return-type
import { command, subcommands } from 'cmd-ts';

import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { runMigrateImagesCommand } from '../migrate-commands.js';
import { createConfigOption } from './command-definition-support.js';

export function createMigrateSubcommands(io: CliIo, _dependencies: CliDependencies) {
	return subcommands({
		name: 'migrate',
		description: 'Migrate deployment-owned config to current agent-vm shapes',
		cmds: {
			images: command({
				name: 'images',
				description: 'Migrate legacy Dockerfile image profiles to managed base overlays',
				args: {
					config: createConfigOption(),
				},
				handler: async ({ config }) => {
					const result = await runMigrateImagesCommand({
						systemConfigPath: config ?? 'config/system.json',
					});
					io.stdout.write(
						`migrated image profiles: ${result.migratedProfiles.length === 0 ? 'none' : result.migratedProfiles.join(', ')}\n`,
					);
					if (result.skippedProfiles.length > 0) {
						io.stdout.write(`skipped image profiles: ${result.skippedProfiles.join(', ')}\n`);
					}
				},
			}),
		},
	});
}
