import { object } from '@optique/core/constructs';
import { map } from '@optique/core/modifiers';
import type { Parser } from '@optique/core/parser';
import { command } from '@optique/core/primitives';

import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { runBuildCommand } from '../build-command.js';
import { createRunTask, createRunTaskGroup } from '../run-task.js';
import { cliDescription } from './command-definition-support.js';
import {
	createConfigOption,
	createPresenceFlag,
	loadSystemConfigFromOption,
} from './command-definition-support.js';

export interface BuildCommand {
	readonly command: 'build';
	readonly options: {
		readonly config: string;
		readonly force: boolean;
		readonly noObservability: boolean;
	};
}

export function createBuildCommand(): Parser<'sync', BuildCommand> {
	return command(
		'build',
		map(
			object({
				config: createConfigOption(),
				force: createPresenceFlag('--force', 'Force rebuild, ignoring cache'),
				noObservability: createPresenceFlag(
					'--no-observability',
					'Skip configured host observability preparation for this build run',
				),
			}),
			(options) => ({ command: 'build' as const, options }),
		),
		{ description: cliDescription('Build Docker OCI images and Gondolin VM assets') },
	);
}

export type BuildCommandOptions = BuildCommand['options'];

export async function runBuildCommandOperation(
	_io: CliIo,
	dependencies: CliDependencies,
	options: BuildCommandOptions,
): Promise<void> {
	const systemConfig = await loadSystemConfigFromOption(options.config, dependencies);
	const runTask = await createRunTask(_io);
	const runTaskGroup = await createRunTaskGroup(_io, runTask);
	await (dependencies.runBuildCommand ?? runBuildCommand)(
		{
			forceRebuild: options.force,
			skipObservability: options.noObservability,
			systemConfig,
		},
		{ runTask, runTaskGroup },
	);
}
