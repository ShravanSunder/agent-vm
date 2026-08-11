import { command, constant, object } from '@optique/core';

import { cliDescription, createConfigOption } from './command-definition-support.js';

export const migrateCommandParser = command(
	'migrate',
	command(
		'images',
		object({
			command: constant('migrate.images'),
			options: object({ config: createConfigOption() }),
		}),
		{
			description: cliDescription(
				'Migrate legacy Dockerfile image profiles to managed base overlays',
			),
		},
	),
	{ description: cliDescription('Migrate deployment-owned config to current agent-vm shapes') },
);
