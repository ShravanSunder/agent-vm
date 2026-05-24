// oxlint-disable typescript-eslint/explicit-function-return-type
import { command, flag } from 'cmd-ts';

import { runConfigValidation } from '../../operations/config-validation.js';
import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { createResolverFromSystemConfig, writeJson } from '../agent-vm-cli-support.js';
import { createConfigOption, loadSystemConfigFromOption } from './command-definition-support.js';

export function createValidateCommand(io: CliIo, dependencies: CliDependencies) {
	return command({
		name: 'validate',
		description: 'Validate agent-vm config files without checking host readiness',
		args: {
			config: createConfigOption(),
			mcpLive: flag({
				long: 'mcp-live',
				description:
					'Start configured MCP Portal providers, run tools/list, and verify profile tool names.',
			}),
		},
		handler: async ({ config, mcpLive }) => {
			const systemConfig = await loadSystemConfigFromOption(config, dependencies);
			const secretResolver = mcpLive
				? await createResolverFromSystemConfig(systemConfig, dependencies)
				: undefined;
			writeJson(
				io,
				await (dependencies.runConfigValidation ?? runConfigValidation)({
					...(dependencies.runCommand ? { runCommand: dependencies.runCommand } : {}),
					...(mcpLive ? { mcpLive: true } : {}),
					...(secretResolver === undefined ? {} : { secretResolver }),
					systemConfig,
				}),
			);
		},
	});
}
