import { command, constant, object, or } from '@optique/core';

import {
	cliDescription,
	createConfigOption,
	createConfirmFlag,
} from './command-definition-support.js';

export const cacheCommandParser = command(
	'cache',
	or(
		command(
			'list',
			object({
				command: constant('cache.list'),
				options: object({ config: createConfigOption() }),
			}),
			{ description: cliDescription('List gateway/tool cache entries') },
		),
		command(
			'clean',
			object({
				command: constant('cache.clean'),
				options: object({ config: createConfigOption(), confirm: createConfirmFlag() }),
			}),
			{ description: cliDescription('Delete stale cache entries') },
		),
	),
	{ description: cliDescription('Manage image cache state') },
);
