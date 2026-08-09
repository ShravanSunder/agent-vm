#!/usr/bin/env node

import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { runOptiqueCliParser } from './optique-cli-support.js';
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

export async function dispatchWorkerCommand(
	commandValue: WorkerCommand,
	io: CliIo,
	operations: WorkerCliOperations = defaultWorkerCliOperations,
): Promise<void> {
	switch (commandValue.command) {
		case 'serve':
			await operations.runServe(commandValue.options, io);
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

export async function runAgentVmWorkerCli(
	argv: readonly string[],
	io: CliIo = { stdout: process.stdout, stderr: process.stderr },
	operations: WorkerCliOperations = defaultWorkerCliOperations,
): Promise<void> {
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
	await dispatchWorkerCommand(result.value, io, operations);
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

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
	await runAgentVmWorkerCli(argv, {
		stdout: process.stdout,
		stderr: process.stderr,
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
