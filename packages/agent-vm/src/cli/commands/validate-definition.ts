import { object } from '@optique/core/constructs';
import { map } from '@optique/core/modifiers';
import type { Parser } from '@optique/core/parser';
import { command } from '@optique/core/primitives';

import { runConfigValidation } from '../../operations/config-validation.js';
import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { createResolverFromSystemConfig, writeJson } from '../agent-vm-cli-support.js';
import { cliDescription } from './command-definition-support.js';
import {
	createConfigOption,
	createPresenceFlag,
	loadSystemConfigFromOption,
} from './command-definition-support.js';

export interface ValidateCommandOptions {
	readonly config: string;
	readonly mcpLive: boolean;
}

export interface ValidateCommand {
	readonly command: 'validate';
	readonly options: ValidateCommandOptions;
}

export function createValidateCommand(): Parser<'sync', ValidateCommand> {
	return command(
		'validate',
		map(
			object({
				config: createConfigOption(),
				mcpLive: createPresenceFlag(
					'--mcp-live',
					'Start configured MCP Portal providers, run tools/list, and verify profile tool names.',
				),
			}),
			(options) => ({ command: 'validate' as const, options }),
		),
		{
			description: cliDescription('Validate agent-vm config files without checking host readiness'),
		},
	);
}

export async function runValidateCommand(
	io: CliIo,
	dependencies: CliDependencies,
	options: ValidateCommandOptions,
): Promise<void> {
	const systemConfig = await loadSystemConfigFromOption(options.config, dependencies);
	const secretResolver = options.mcpLive
		? await createResolverFromSystemConfig(systemConfig, dependencies)
		: undefined;
	writeJson(
		io,
		await (dependencies.runConfigValidation ?? runConfigValidation)({
			...(dependencies.runCommand ? { runCommand: dependencies.runCommand } : {}),
			...(options.mcpLive ? { mcpLive: true } : {}),
			...(secretResolver === undefined ? {} : { secretResolver }),
			systemConfig,
		}),
	);
}
