import { command, constant, object } from '@optique/core';

import {
	cliDescription,
	createConfigOption,
	createPresenceFlag,
} from './command-definition-support.js';

export const validateCommandParser = command(
	'validate',
	object({
		command: constant('validate'),
		options: object({
			config: createConfigOption(),
			mcpLive: createPresenceFlag(
				'--mcp-live',
				'Start configured MCP Portal providers, run tools/list, and verify profile tool names.',
			),
		}),
	}),
	{ description: cliDescription('Validate agent-vm config files without checking host readiness') },
);
