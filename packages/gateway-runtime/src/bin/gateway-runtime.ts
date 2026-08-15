#!/usr/bin/env node

import { run } from '@optique/run';

import { dispatchGatewayRuntimeCommand } from './gateway-runtime-cli-dispatcher.js';
import { gatewayRuntimeRootParser } from './gateway-runtime-cli-parser.js';

const command = run(gatewayRuntimeRootParser, {
	help: 'both',
	programName: 'agent-vm-gateway-runtime',
	showDefault: true,
});

void dispatchGatewayRuntimeCommand(command).catch(() => {
	process.stderr.write('Gateway runtime service failed.\n');
	process.exitCode = 1;
});
