import { argument, command, constant, object, or } from '@optique/core';
import { zod } from '@optique/zod';
import { z } from 'zod';

import {
	cliDescription,
	createConfigOption,
	createZoneOption,
} from './command-definition-support.js';

const backupPathSchema = z.string().min(1);

const backupZoneOptionsParser = object({ config: createConfigOption(), zone: createZoneOption() });

export const backupCommandParser = command(
	'backup',
	or(
		command(
			'create',
			object({
				command: constant('backup.create'),
				options: backupZoneOptionsParser,
			}),
			{ description: cliDescription('Create a zone backup') },
		),
		command(
			'list',
			object({
				command: constant('backup.list'),
				options: backupZoneOptionsParser,
			}),
			{ description: cliDescription('List backups for a zone') },
		),
		command(
			'restore',
			object({
				command: constant('backup.restore'),
				options: object({
					backupPath: argument(
						zod(backupPathSchema, { metavar: 'PATH', placeholder: 'backup.age' }),
						{ description: cliDescription('Path to the encrypted backup file') },
					),
					config: createConfigOption(),
					zone: createZoneOption(),
				}),
			}),
			{ description: cliDescription('Restore a backup into a zone') },
		),
	),
	{ description: cliDescription('Manage encrypted zone backups') },
);
