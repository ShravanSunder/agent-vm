#!/usr/bin/env node
try {
	process.loadEnvFile('.env.local');
} catch {
	// .env.local is optional.
}

import { pathToFileURL } from 'node:url';

import {
	defaultCliDependencies,
	type CliDependencies,
	type CliIo,
	resolveConfigPath,
} from './agent-vm-cli-support.js';
import { scaffoldAgentVmProject } from './init-command.js';
import { runControllerOperationCommand } from './controller-operation-commands.js';
import { runLeaseCommand } from './lease-commands.js';
import { runSnapshotCommand } from './snapshot-commands.js';
import { runSshCommand } from './ssh-commands.js';

export async function runAgentVmCli(
	argv: readonly string[],
	io: CliIo,
	dependencies: CliDependencies = defaultCliDependencies,
): Promise<void> {
	const [commandGroup, subcommand, ...restArguments] = argv;
	if (commandGroup === 'init') {
		const zoneId = subcommand || 'default';
		const result = (dependencies.scaffoldAgentVmProject ?? scaffoldAgentVmProject)({
			targetDir: dependencies.getCurrentWorkingDirectory?.() ?? process.cwd(),
			zoneId,
		});
		io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
		case 'snapshot':
			await runSnapshotCommand({ dependencies, io, restArguments, systemConfig });
			return;
		case 'ssh-cmd':
			await runSshCommand({ dependencies, io, restArguments, systemConfig });
			return;
	}

	throw new Error(`Unknown controller subcommand '${subcommand}'.`);
}

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
