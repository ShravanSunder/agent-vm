#!/usr/bin/env node
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

import { pathToFileURL } from 'node:url';

import { runSafely } from 'cmd-ts';

import {
	defaultCliDependencies,
	type CliDependencies,
	type CliIo,
} from './agent-vm-cli-support.js';
import { createAgentVmApp } from './commands/create-app.js';

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
		throw new Error(result.error.config.message);
	}
}

export { loadOptionalLocalEnvironmentFile };

async function main(): Promise<void> {
	await runAgentVmCli(process.argv.slice(2), {
		stderr: process.stderr,
		stdout: process.stdout,
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	void main().catch((error: unknown) => {
		if (!(error instanceof Error)) {
			process.stderr.write(`${String(error)}\n`);
		}
		process.exitCode = 1;
	});
}
