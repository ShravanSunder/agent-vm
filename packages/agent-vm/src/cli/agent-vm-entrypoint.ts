#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function loadOptionalLocalEnvironmentFile(environmentFilePath: string = '.env.local'): void {
	try {
		process.loadEnvFile(environmentFilePath);
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return;
		}

		throw new Error(
			`Failed to load ${environmentFilePath}: ${error instanceof Error ? error.message : String(error)}`,
			{
				cause: error,
			},
		);
	}
}

loadOptionalLocalEnvironmentFile();

import { runSafely } from 'cmd-ts';

import {
	defaultCliDependencies,
	type CliDependencies,
	type CliIo,
} from './agent-vm-cli-support.js';
import { createAgentVmApp } from './commands/create-app.js';

export class ReportedCliError extends Error {}

export async function runAgentVmCli(
	argv: readonly string[],
	io: CliIo,
	dependencies: CliDependencies = defaultCliDependencies,
): Promise<void> {
	const result = await runSafely(createAgentVmApp(io, dependencies), [...argv]);
	if (result._tag === 'ok') {
		return;
	}
	const outputStream = result.error.config.into === 'stderr' ? io.stderr : io.stdout;
	outputStream.write(result.error.config.message);
	if (!result.error.config.message.endsWith('\n')) {
		outputStream.write('\n');
	}
	if (result.error.config.exitCode !== 0) {
		throw new ReportedCliError(result.error.config.message);
	}
}

export { loadOptionalLocalEnvironmentFile };

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

async function main(): Promise<void> {
	await runAgentVmCli(process.argv.slice(2), {
		stderr: process.stderr,
		stdout: process.stdout,
	});
}

export function isCliEntrypoint(importMetaUrl: string, argvEntryPath: string | undefined): boolean {
	if (!argvEntryPath) {
		return false;
	}
	try {
		return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(argvEntryPath);
	} catch {
		return false;
	}
}

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
	void main().catch((error: unknown) => {
		handleCliMainError(error, process.stderr);
		process.exitCode = 1;
	});
}
