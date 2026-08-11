#!/usr/bin/env node

import { realpath } from 'node:fs/promises';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { runOptiqueCliParser } from './optique-cli-support.js';
import {
	configureProcessLogging,
	workerProcessLoggingShutdownFailureMessage,
	type ProcessLoggingHandle,
	type ProcessLoggingOptions,
} from './shared/process-logging.js';
import {
	defaultWorkerCliOperations,
	type CliIo,
	type WorkerCliOperations,
} from './worker-cli-operations.js';
import { createWorkerCommandParser, type WorkerCommand } from './worker-command-parser.js';

export type { CliIo, WorkerCliOperations } from './worker-cli-operations.js';
export type {
	HealthCommand,
	HealthCommandOptions,
	ServeCommand,
	ServeCommandOptions,
	WorkerCommand,
} from './worker-command-parser.js';

export class ReportedCliError extends Error {}

export interface WorkerProcessIo {
	readonly stdout: Writable;
	readonly stderr: Writable;
}

export interface DispatchWorkerCommandOptions {
	readonly commandValue: WorkerCommand;
	readonly io: CliIo;
	readonly operations?: WorkerCliOperations | undefined;
	readonly logging?: ProcessLoggingHandle | undefined;
}

export async function dispatchWorkerCommand(options: DispatchWorkerCommandOptions): Promise<void> {
	const { commandValue, io, operations = defaultWorkerCliOperations, logging } = options;
	switch (commandValue.command) {
		case 'serve':
			await operations.runServe(commandValue.options, io, logging);
			return;
		case 'health':
			await operations.runHealth(commandValue.options, io);
			return;
		default: {
			const unreachableCommand: never = commandValue;
			throw new Error(`Unhandled agent-vm-worker command: ${String(unreachableCommand)}`);
		}
	}
}

export interface RunAgentVmWorkerCliOptions {
	readonly argv: readonly string[];
	readonly io?: CliIo | undefined;
	readonly operations?: WorkerCliOperations | undefined;
	readonly logging?: ProcessLoggingHandle | undefined;
}

export async function runAgentVmWorkerCli(options: RunAgentVmWorkerCliOptions): Promise<void> {
	const {
		argv,
		io = { stdout: process.stdout, stderr: process.stderr },
		operations = defaultWorkerCliOperations,
		logging,
	} = options;
	const parseErrorChunks: string[] = [];
	const result = runOptiqueCliParser({
		argv,
		io: {
			stdout: io.stdout,
			stderr: {
				write: (chunk: string | Uint8Array): boolean => {
					parseErrorChunks.push(String(chunk));
					return io.stderr.write(chunk);
				},
			},
		},
		parser: createWorkerCommandParser(),
		programName: 'agent-vm-worker',
	});
	if (result.kind === 'help' || result.kind === 'version') {
		return;
	}
	if (result.kind === 'parse-error') {
		throw new ReportedCliError(parseErrorChunks.join('') || 'CLI argument parsing failed.');
	}
	await dispatchWorkerCommand({ commandValue: result.value, io, operations, logging });
}

export function handleCliMainError(
	error: unknown,
	stderr: Pick<NodeJS.WriteStream, 'write'>,
): void {
	if (error instanceof ReportedCliError) {
		return;
	}
	if (error instanceof Error) {
		stderr.write(`${error.message}\n`);
		return;
	}
	stderr.write(`${String(error)}\n`);
}

export interface WorkerProcessOptions {
	readonly argv: readonly string[];
	readonly io: WorkerProcessIo;
	readonly operations?: WorkerCliOperations | undefined;
	readonly configureProcessLogging?:
		| ((options: ProcessLoggingOptions) => Promise<ProcessLoggingHandle>)
		| undefined;
}

export async function runWorkerProcess(options: WorkerProcessOptions): Promise<void> {
	const configureLogging = options.configureProcessLogging ?? configureProcessLogging;
	let logging: ProcessLoggingHandle;
	try {
		logging = await configureLogging({ stderr: options.io.stderr });
	} catch (error: unknown) {
		throw new Error('Worker process logging setup failed.', { cause: error });
	}
	try {
		await runAgentVmWorkerCli({
			argv: options.argv,
			io: options.io,
			operations: options.operations ?? defaultWorkerCliOperations,
			logging,
		});
	} finally {
		await logging.shutdown().catch(() => {
			options.io.stderr.write(workerProcessLoggingShutdownFailureMessage);
		});
	}
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
	await runWorkerProcess({
		argv,
		io: {
			stdout: process.stdout,
			stderr: process.stderr,
		},
	});
}

export async function isCliEntrypoint(
	importMetaUrl: string,
	argvEntryPath: string | undefined,
): Promise<boolean> {
	if (!argvEntryPath) {
		return false;
	}
	try {
		const [realEntrypointPath, realArgvEntryPath] = await Promise.all([
			realpath(fileURLToPath(importMetaUrl)),
			realpath(argvEntryPath),
		]);
		return realEntrypointPath === realArgvEntryPath;
	} catch {
		return false;
	}
}

async function runCliEntrypoint(): Promise<void> {
	if (!(await isCliEntrypoint(import.meta.url, process.argv[1]))) {
		return;
	}
	try {
		await main();
	} catch (error: unknown) {
		handleCliMainError(error, process.stderr);
		process.exitCode = 1;
	}
}

if (process.argv[1] !== undefined) {
	void runCliEntrypoint();
}
