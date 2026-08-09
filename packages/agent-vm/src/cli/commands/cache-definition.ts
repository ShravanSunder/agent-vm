import { object, or } from '@optique/core/constructs';
import { map } from '@optique/core/modifiers';
import type { Parser } from '@optique/core/parser';
import { command } from '@optique/core/primitives';

import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { runCacheCommand } from '../cache-commands.js';
import { cliDescription } from './command-definition-support.js';
import {
	createConfigOption,
	createConfirmFlag,
	loadSystemConfigFromOption,
} from './command-definition-support.js';

interface CacheListOptions {
	readonly config: string;
}

interface CacheCleanOptions extends CacheListOptions {
	readonly confirm: boolean;
}

export type CacheCommand =
	| { readonly command: 'cache.list'; readonly options: CacheListOptions }
	| { readonly command: 'cache.clean'; readonly options: CacheCleanOptions };

export function createCacheSubcommands(): Parser<'sync', CacheCommand> {
	const list = command(
		'list',
		map(object({ config: createConfigOption() }), (options) => ({
			command: 'cache.list' as const,
			options,
		})),
		{ description: cliDescription('List gateway/tool cache entries') },
	);
	const clean = command(
		'clean',
		map(object({ config: createConfigOption(), confirm: createConfirmFlag() }), (options) => ({
			command: 'cache.clean' as const,
			options,
		})),
		{ description: cliDescription('Delete stale cache entries') },
	);
	return command('cache', or(list, clean), {
		description: cliDescription('Manage image cache state'),
	});
}

export async function runCacheCommandOperation(
	io: CliIo,
	dependencies: CliDependencies,
	commandValue: CacheCommand,
): Promise<void> {
	if (commandValue.command === 'cache.list') {
		await (dependencies.runCacheCommand ?? runCacheCommand)(
			{
				subcommand: 'list',
				systemConfig: await loadSystemConfigFromOption(commandValue.options.config, dependencies),
			},
			io,
		);
		return;
	}
	await (dependencies.runCacheCommand ?? runCacheCommand)(
		{
			confirm: commandValue.options.confirm,
			subcommand: 'clean',
			systemConfig: await loadSystemConfigFromOption(commandValue.options.config, dependencies),
		},
		io,
	);
}
