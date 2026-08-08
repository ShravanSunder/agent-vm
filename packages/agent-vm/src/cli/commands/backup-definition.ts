import { object, or } from '@optique/core/constructs';
import { map } from '@optique/core/modifiers';
import type { Parser } from '@optique/core/parser';
import { argument, command } from '@optique/core/primitives';
import { zod } from '@optique/zod';
import { z } from 'zod';

import { type CliDependencies, type CliIo, requireZone } from '../agent-vm-cli-support.js';
import { runBackupCommand } from '../backup-commands.js';
import { cliDescription } from './command-definition-support.js';
import {
	appendZoneArgument,
	createConfigOption,
	createZoneOption,
	loadSystemConfigFromOption,
} from './command-definition-support.js';

interface BackupZoneOptions {
	readonly config: string;
	readonly zone: string | undefined;
}

interface BackupRestoreOptions extends BackupZoneOptions {
	readonly backupPath: string;
}

export type BackupCommand =
	| { readonly command: 'backup.create'; readonly options: BackupZoneOptions }
	| { readonly command: 'backup.list'; readonly options: BackupZoneOptions }
	| { readonly command: 'backup.restore'; readonly options: BackupRestoreOptions };

export function createBackupSubcommands(): Parser<'sync', BackupCommand> {
	const create = command(
		'create',
		map(object({ config: createConfigOption(), zone: createZoneOption() }), (options) => ({
			command: 'backup.create' as const,
			options,
		})),
		{ description: cliDescription('Create a zone backup') },
	);
	const list = command(
		'list',
		map(object({ config: createConfigOption(), zone: createZoneOption() }), (options) => ({
			command: 'backup.list' as const,
			options,
		})),
		{ description: cliDescription('List backups for a zone') },
	);
	const restore = command(
		'restore',
		map(
			object({
				backupPath: argument(zod(z.string(), { metavar: 'PATH', placeholder: 'backup.age' }), {
					description: cliDescription('Path to the encrypted backup file'),
				}),
				config: createConfigOption(),
				zone: createZoneOption(),
			}),
			(options) => ({ command: 'backup.restore' as const, options }),
		),
		{ description: cliDescription('Restore a backup into a zone') },
	);
	return command('backup', or(create, list, restore), {
		description: cliDescription('Manage encrypted zone backups'),
	});
}

export async function runBackupCommandOperation(
	io: CliIo,
	dependencies: CliDependencies,
	commandValue: BackupCommand,
): Promise<void> {
	const systemConfig = await loadSystemConfigFromOption(commandValue.options.config, dependencies);
	const selectedZone = requireZone(systemConfig, commandValue.options.zone);
	const restArguments =
		commandValue.command === 'backup.restore'
			? appendZoneArgument(['restore', commandValue.options.backupPath], selectedZone.id)
			: appendZoneArgument(
					[commandValue.command === 'backup.create' ? 'create' : 'list'],
					selectedZone.id,
				);
	await runBackupCommand({ dependencies, io, restArguments, systemConfig });
}
