import { command, constant, object, or } from '@optique/core';

import { cliDescription, createPresenceFlag } from './command-definition-support.js';

const resourcesJsonOptionsParser = object({
	json: createPresenceFlag('--json', 'Print machine-readable JSON output'),
});

const resourcesInitParser = command(
	'init',
	object({ command: constant('resources.init'), options: resourcesJsonOptionsParser }),
	{ description: cliDescription('Scaffold .agent-vm resource files in the current repo') },
);

const resourcesValidateParser = command(
	'validate',
	object({ command: constant('resources.validate'), options: resourcesJsonOptionsParser }),
	{ description: cliDescription('Validate .agent-vm resource files in the current repo') },
);

const resourcesUpdateParser = command(
	'update',
	object({ command: constant('resources.update'), options: resourcesJsonOptionsParser }),
	{ description: cliDescription('Update generated .agent-vm resource support files') },
);

export const resourcesCommandParser = command(
	'resources',
	or(resourcesInitParser, resourcesValidateParser, resourcesUpdateParser),
	{ description: cliDescription('Scaffold and validate repo resource files') },
);
