#!/usr/bin/env node

import { run } from '@optique/run';

import { dispatchWorkerCommand } from './worker-cli-dispatcher.js';
import { workerCliBrief, workerCommandParser } from './worker-cli-parser.js';

export async function main(): Promise<void> {
	const command = run(workerCommandParser, {
		brief: workerCliBrief,
		help: {
			command: true,
			option: { names: ['--help', '-h'] },
		},
		programName: 'agent-vm-worker',
		showDefault: true,
	});
	await dispatchWorkerCommand(command);
}

void main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
