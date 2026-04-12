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

import {
	defaultCliDependencies,
	type CliDependencies,
	type CliIo,
	resolveConfigPath,
	resolveZoneId,
} from './agent-vm-cli-support.js';
import { runAuthCommand } from './auth-command.js';
import { runBackupCommand } from './backup-commands.js';
import { runBuildCommand } from './build-command.js';
import { runCacheCommand } from './cache-commands.js';
import { runControllerOperationCommand } from './controller-operation-commands.js';
import { promptAndStoreServiceAccountToken, scaffoldAgentVmProject } from './init-command.js';
import { runLeaseCommand } from './lease-commands.js';
import { runSshCommand } from './ssh-commands.js';

export async function runAgentVmCli(
	argv: readonly string[],
	io: CliIo,
	dependencies: CliDependencies = defaultCliDependencies,
): Promise<void> {
	const [commandGroup, subcommand, ...restArguments] = argv;
	if (commandGroup === 'init') {
		const zoneId = subcommand ?? 'default';
		const result = (dependencies.scaffoldAgentVmProject ?? scaffoldAgentVmProject)({
			targetDir: dependencies.getCurrentWorkingDirectory?.() ?? process.cwd(),
			zoneId,
		});

		const keychainStored = await (
			dependencies.promptAndStoreServiceAccountToken ?? promptAndStoreServiceAccountToken
		)();

		io.stdout.write(`${JSON.stringify({ ...result, keychainStored }, null, 2)}\n`);
		return;
	}
	if (commandGroup === 'build') {
		const buildArguments =
			subcommand === undefined
				? restArguments
				: ([subcommand, ...restArguments] as readonly string[]);
		const forceRebuild = buildArguments.includes('--force');
		const systemConfig = dependencies.loadSystemConfig(resolveConfigPath(buildArguments));
		await (dependencies.runBuildCommand ?? runBuildCommand)({ forceRebuild, systemConfig });
		return;
	}
	if (commandGroup === 'cache') {
		const cacheArguments =
			subcommand === undefined
				? restArguments
				: ([subcommand, ...restArguments] as readonly string[]);
		const systemConfig = dependencies.loadSystemConfig(resolveConfigPath(cacheArguments));
		const confirm = cacheArguments.includes('--confirm');
		await (dependencies.runCacheCommand ?? runCacheCommand)(
			{
				confirm,
				subcommand: subcommand ?? 'list',
				systemConfig,
			},
			io,
		);
		return;
	}
	if (commandGroup === 'backup') {
		const backupArguments =
			subcommand === undefined
				? restArguments
				: ([subcommand, ...restArguments] as readonly string[]);
		const systemConfig = dependencies.loadSystemConfig(resolveConfigPath(backupArguments));
		await runBackupCommand({
			dependencies,
			io,
			restArguments: backupArguments,
			systemConfig,
		});
		return;
	}
	if (commandGroup === 'auth') {
		if (!subcommand) {
			throw new Error('Usage: agent-vm auth <plugin> --zone <id>');
		}
		const systemConfig = dependencies.loadSystemConfig(resolveConfigPath(restArguments));
		await runAuthCommand({
			dependencies,
			io,
			pluginName: subcommand,
			systemConfig,
			zoneId: resolveZoneId(systemConfig, restArguments),
		});
		return;
	}

	if (commandGroup !== 'controller') {
		throw new Error('Expected command group "controller".');
	}
	if (subcommand === undefined) {
		throw new Error('Expected a controller subcommand.');
	}

	const systemConfig = dependencies.loadSystemConfig(resolveConfigPath(restArguments));

	switch (subcommand) {
		case 'credentials':
		case 'destroy':
		case 'doctor':
		case 'logs':
		case 'start':
		case 'status':
		case 'stop':
		case 'upgrade':
			await runControllerOperationCommand({
				dependencies,
				io,
				restArguments,
				subcommand,
				systemConfig,
			});
			return;
		case 'lease':
			await runLeaseCommand({ dependencies, io, restArguments, systemConfig });
			return;
		case 'ssh-cmd':
			await runSshCommand({ dependencies, io, restArguments, systemConfig });
			return;
	}

	throw new Error(`Unknown controller subcommand '${subcommand}'.`);
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
		process.stderr.write(`${String(error)}\n`);
		process.exitCode = 1;
	});
}
