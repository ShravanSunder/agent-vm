#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { run } from '@optique/run';

import { defaultCliDependencies } from './agent-vm-cli-support.js';
import { dispatchAgentVmCommand } from './agent-vm-command-dispatcher.js';
import { agentVmRootParser } from './agent-vm-command-parser.js';
import { resolveCliVersion } from './cli-version.js';

function loadOptionalLocalEnvironmentFile(environmentFilePath: string = '.env.local'): void {
	try {
		process.loadEnvFile(environmentFilePath);
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return;
		}

		throw new Error(
			`Failed to load ${environmentFilePath}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}

loadOptionalLocalEnvironmentFile();

export { loadOptionalLocalEnvironmentFile };

export function handleCliMainError(
	error: unknown,
	stderr: Pick<NodeJS.WriteStream, 'write'>,
): void {
	stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
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

async function main(): Promise<void> {
	const cliVersion = await (defaultCliDependencies.resolveCliVersion ?? resolveCliVersion)();
	const command = run(agentVmRootParser, {
		help: 'both',
		programName: 'agent-vm',
		showDefault: true,
		stderr: (text) => process.stderr.write(`${text}\n`),
		stdout: (text) => process.stdout.write(`${text}\n`),
		version: cliVersion,
	});
	await dispatchAgentVmCommand(
		command,
		{ stderr: process.stderr, stdout: process.stdout },
		defaultCliDependencies,
	);
}

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
	void main().catch((error: unknown) => {
		handleCliMainError(error, process.stderr);
		process.exitCode = 1;
	});
}
