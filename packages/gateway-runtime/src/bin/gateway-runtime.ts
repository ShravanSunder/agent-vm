#!/usr/bin/env node

import { run } from '@optique/run';

import { dispatchGatewayRuntimeCommand } from './gateway-runtime-cli-dispatcher.js';
import { gatewayRuntimeRootParser } from './gateway-runtime-cli-parser.js';

const command = run(gatewayRuntimeRootParser, { help: 'both', showDefault: true });

void dispatchGatewayRuntimeCommand(command).catch(() => {
	try {
		process.stderr.write('Gateway runtime service failed.\n');
	} catch {
		// Preserve the process result when stderr is unavailable.
	}
	process.exitCode = 1;
});
