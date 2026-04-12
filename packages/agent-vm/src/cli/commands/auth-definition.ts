// oxlint-disable typescript-eslint/explicit-function-return-type
import { command, positional, string, subcommands } from 'cmd-ts';

import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { resolveZoneId } from '../agent-vm-cli-support.js';
import { runAuthCommand } from '../auth-command.js';
import {
	createConfigOption,
	createZoneOption,
	loadSystemConfigFromOption,
} from './command-definition-support.js';

export function createOpenClawSubcommands(io: CliIo, dependencies: CliDependencies) {
	return subcommands({
		name: 'openclaw',
		description: 'OpenClaw-specific operations',
		cmds: {
			auth: command({
				name: 'auth',
				description: 'Run a model provider OAuth flow inside the gateway VM',
				args: {
					config: createConfigOption(),
					provider: positional({
						displayName: 'provider',
						type: string,
						description: 'Provider name (for example: codex)',
					}),
					zone: createZoneOption(),
				},
				handler: async ({ config, provider, zone }) => {
					const systemConfig = loadSystemConfigFromOption(config, dependencies);
					await runAuthCommand({
						dependencies,
						io,
						pluginName: provider,
						systemConfig,
						zoneId: resolveZoneId(systemConfig, zone ? ['--zone', zone] : []),
					});
				},
			}),
		},
	});
}
