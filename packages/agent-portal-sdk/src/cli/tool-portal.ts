#!/usr/bin/env node

import { run } from '@optique/run';

import { dispatchToolPortalCommand } from './tool-portal-cli-dispatcher.js';
import { toolPortalRootParser } from './tool-portal-cli-parser.js';

const command = run(toolPortalRootParser, {
	errorExitCode: 2,
	help: 'both',
	programName: 'tool-portal',
	showDefault: true,
});

process.exitCode = await dispatchToolPortalCommand(command, process.env);
