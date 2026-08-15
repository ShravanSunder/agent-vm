import { command, constant, object } from '@optique/core';

import {
	cliDescription,
	createConfigOption,
	createPresenceFlag,
} from './command-definition-support.js';

export const buildCommandParser = command(
	'build',
	object({
		command: constant('build'),
		options: object({
			config: createConfigOption(),
			force: createPresenceFlag('--force', 'Force rebuild, ignoring cache'),
			noObservability: createPresenceFlag(
				'--no-observability',
				'Skip configured host observability preparation for this build run',
			),
		}),
	}),
	{ description: cliDescription('Build Docker OCI images and Gondolin VM assets') },
);
