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

import {
	defaultCliDependencies,
	type CliDependencies,
	type CliIo,
} from './agent-vm-cli-support.js';
import { resolveCliVersion } from './cli-version.js';
import { runAuthCommand } from './commands/auth-definition.js';
import { runBackupCommandOperation } from './commands/backup-definition.js';
import { runBuildCommandOperation } from './commands/build-definition.js';
import { runCacheCommandOperation } from './commands/cache-definition.js';
import { runConfigCommand } from './commands/config-definition.js';
import { runControllerCommand } from './commands/controller-definition.js';
import { createAgentVmParser, type AgentVmCommand } from './commands/create-app.js';
import { runDoctorCommand } from './commands/doctor-definition.js';
import { runInitCommand } from './commands/init-definition.js';
import { runManualCommand } from './commands/manual-definition.js';
import { runMigrateCommand } from './commands/migrate-definition.js';
import { runPathsCommand } from './commands/paths-definition.js';
import { runResourcesCommand } from './commands/resources-definition.js';
import { runValidateCommand } from './commands/validate-definition.js';
import { runOptiqueCliParser } from './optique-cli-support.js';

export class ReportedCliError extends Error {}

export async function dispatchAgentVmCommand(
	commandValue: AgentVmCommand,
	io: CliIo,
	dependencies: CliDependencies,
): Promise<void> {
	switch (commandValue.command) {
		case 'init':
			await runInitCommand(io, dependencies, commandValue.options);
			return;
		case 'build':
			await runBuildCommandOperation(io, dependencies, commandValue.options);
			return;
		case 'validate':
			await runValidateCommand(io, dependencies, commandValue.options);
			return;
		case 'doctor':
			await runDoctorCommand(io, dependencies, commandValue.options);
			return;
		case 'cache.list':
		case 'cache.clean':
			await runCacheCommandOperation(io, dependencies, commandValue);
			return;
		case 'config.reset-instructions':
			await runConfigCommand(io, dependencies, commandValue.options);
			return;
		case 'manual.update':
			await runManualCommand(io, dependencies, commandValue.options);
			return;
		case 'migrate.images':
			await runMigrateCommand(io, dependencies, commandValue.options);
			return;
		case 'paths.show':
			await runPathsCommand(io, dependencies, commandValue.options);
			return;
		case 'resources.init':
		case 'resources.validate':
		case 'resources.update':
			await runResourcesCommand(io, dependencies, commandValue);
			return;
		case 'backup.create':
		case 'backup.list':
		case 'backup.restore':
			await runBackupCommandOperation(io, dependencies, commandValue);
			return;
		case 'auth.1password':
		case 'auth.codex-harness':
		case 'auth.openclaw.login':
			await runAuthCommand(io, dependencies, commandValue);
			return;
		case 'controller.start':
		case 'controller.stop':
		case 'controller.cleanup':
		case 'controller.status':
		case 'controller.health':
		case 'controller.health-snapshot':
		case 'controller.service-health':
		case 'controller.ssh':
		case 'controller.destroy':
		case 'controller.upgrade':
		case 'controller.logs':
		case 'controller.credentials.check':
		case 'controller.credentials.refresh':
			await runControllerCommand(io, dependencies, commandValue);
			return;
		default: {
			const unreachableCommand: never = commandValue;
			throw new Error(`Unhandled agent-vm command: ${String(unreachableCommand)}`);
		}
	}
}

export async function runAgentVmCli(
	argv: readonly string[],
	io: CliIo,
	dependencies: CliDependencies = defaultCliDependencies,
): Promise<void> {
	const cliVersion = await (dependencies.resolveCliVersion ?? resolveCliVersion)();
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
		parser: createAgentVmParser(),
		programName: 'agent-vm',
		version: cliVersion,
	});
	if (result.kind === 'help' || result.kind === 'version') {
		return;
	}
	if (result.kind === 'parse-error') {
		throw new ReportedCliError(parseErrorChunks.join('') || 'CLI argument parsing failed.');
	}
	await dispatchAgentVmCommand(result.value, io, dependencies);
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
