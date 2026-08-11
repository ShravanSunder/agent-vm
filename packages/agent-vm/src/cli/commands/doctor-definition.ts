import { command, constant, object } from '@optique/core';

import {
	cliDescription,
	createConfigOption,
	createPresenceFlag,
} from './command-definition-support.js';

export const doctorCommandParser = command(
	'doctor',
	object({
		command: constant('doctor'),
		options: object({
			config: createConfigOption(),
			json: createPresenceFlag('--json', 'Print machine-readable JSON output'),
			showPassed: createPresenceFlag(
				'--show-passed',
				'Include passed checks in human-readable output',
			),
		}),
	}),
	{
		description: cliDescription('Check offline prerequisites for the configured agent-vm project'),
	},
);
