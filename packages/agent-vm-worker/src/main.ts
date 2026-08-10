#!/usr/bin/env node

import { run } from '@optique/run';

import {
	configureProcessLogging,
	workerProcessLoggingShutdownFailureMessage,
	type ProcessLoggingHandle,
} from './shared/process-logging.js';
import {
	runWorkerHealthOperation,
	runWorkerServeLifecycle,
} from './worker-cli-operations.js';
import { dispatchWorkerCommand } from './worker-cli-dispatcher.js';
import {
	workerCliBrief,
	workerCommandParser,
	type WorkerCommand,
} from './worker-cli-parser.js';

type WorkerServeCommand = Extract<WorkerCommand, { readonly command: 'serve' }>;

async function runWorkerServeProcess(command: WorkerServeCommand): Promise<void> {
	let logging: ProcessLoggingHandle;
	try {
		logging = await configureProcessLogging({ stderr: process.stderr });
	} catch (error: unknown) {
		throw new Error('Worker process logging setup failed.', { cause: error });
	}

	try {
		await dispatchWorkerCommand(command, {
			runHealth: runWorkerHealthOperation,
			runServe: (serveCommand): Promise<void> =>
				runWorkerServeLifecycle(serveCommand, logging),
		});
	} finally {
		await logging.shutdown().catch(() => {
			try {
				process.stderr.write(workerProcessLoggingShutdownFailureMessage);
			} catch {
				// Preserve the product result when the fallback diagnostic writer fails.
			}
		});
	}
}

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
	if (command.command === 'health') {
		await dispatchWorkerCommand(command);
		return;
	}
	await runWorkerServeProcess(command);
}

void main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
