import { command, constant, object } from '@optique/core';

import {
	cliDescription,
	createConfigOption,
	createPresenceFlag,
} from './command-definition-support.js';

export const pathsCommandParser = command(
	'paths',
	command(
		'show',
		object({
			command: constant('paths.show'),
			options: object({
				config: createConfigOption(),
				sizes: createPresenceFlag('--sizes', 'Walk each path and print disk usage (slower)'),
			}),
		}),
		{ description: cliDescription('Print all resolved paths and their on-disk size') },
	),
	{ description: cliDescription('Inspect paths resolved from system.json') },
);
