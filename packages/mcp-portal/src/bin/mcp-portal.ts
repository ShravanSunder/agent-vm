#!/usr/bin/env node

import { basename } from 'node:path';

import { run } from '@optique/run';

import { mcpPortalRootParser } from '../cli/mcp-portal-cli-parser.js';
import { runMcpPortalCommand } from './mcp-portal-command-dispatcher.js';

export function shouldRunMcpPortalEntrypoint(argvPath: string | undefined): boolean {
	const entrypointName = argvPath === undefined ? undefined : basename(argvPath);
	return (
		entrypointName === 'mcp-portal' ||
		entrypointName === 'mcp-portal.js' ||
		entrypointName === 'mcp-portal.ts'
	);
}

if (shouldRunMcpPortalEntrypoint(process.argv[1])) {
	const command = run(mcpPortalRootParser, {
		commandList: 'top-level',
		help: 'both',
		programName: 'mcp-portal',
		showDefault: true,
	});
	process.exitCode = await runMcpPortalCommand(command);
}
