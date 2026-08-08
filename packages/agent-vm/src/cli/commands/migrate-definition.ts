import { object } from '@optique/core/constructs';
import { map } from '@optique/core/modifiers';
import type { Parser } from '@optique/core/parser';
import { command } from '@optique/core/primitives';

import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { runMigrateImagesCommand } from '../migrate-commands.js';
import { cliDescription } from './command-definition-support.js';
import { createConfigOption } from './command-definition-support.js';

export interface MigrateCommandOptions {
	readonly config: string;
}

export interface MigrateCommand {
	readonly command: 'migrate.images';
	readonly options: MigrateCommandOptions;
}

export function createMigrateSubcommands(): Parser<'sync', MigrateCommand> {
	return command(
		'migrate',
		command(
			'images',
			map(object({ config: createConfigOption() }), (options) => ({
				command: 'migrate.images' as const,
				options,
			})),
			{
				description: cliDescription(
					'Migrate legacy Dockerfile image profiles to managed base overlays',
				),
			},
		),
		{ description: cliDescription('Migrate deployment-owned config to current agent-vm shapes') },
	);
}

export async function runMigrateCommand(
	io: CliIo,
	_options: CliDependencies,
	options: MigrateCommandOptions,
): Promise<void> {
	const result = await runMigrateImagesCommand({ systemConfigPath: options.config });
	io.stdout.write(
		`migrated image profiles: ${result.migratedProfiles.length === 0 ? 'none' : result.migratedProfiles.join(', ')}\n`,
	);
	if (result.skippedProfiles.length > 0) {
		io.stdout.write(`skipped image profiles: ${result.skippedProfiles.join(', ')}\n`);
	}
}
