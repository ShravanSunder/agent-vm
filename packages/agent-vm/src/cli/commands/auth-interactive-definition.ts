// oxlint-disable typescript-eslint/explicit-function-return-type
import { command, optional, positional, string } from 'cmd-ts';

import { loadGatewayLifecycle } from '../../gateway/gateway-lifecycle-loader.js';
import { type CliDependencies, type CliIo, requireZone } from '../agent-vm-cli-support.js';
import { runAuthInteractiveCommand } from '../auth-interactive-command.js';
import {
	createConfigOption,
	createZoneOption,
	loadSystemConfigFromOption,
} from './command-definition-support.js';

export function createAuthInteractiveCommand(io: CliIo, dependencies: CliDependencies) {
	return command({
		name: 'auth-interactive',
		description:
			'Run interactive auth for a gateway zone. Omitting the provider lists available providers.',
		args: {
			config: createConfigOption(),
			provider: positional({
				displayName: 'provider',
				type: optional(string),
				description: 'Provider name (for example: codex)',
			}),
			zone: createZoneOption(),
		},
		handler: async ({ config, provider, zone }) => {
			const systemConfig = await loadSystemConfigFromOption(config, dependencies);
			const selectedZone = requireZone(systemConfig, zone);
			const lifecycle = loadGatewayLifecycle(selectedZone.gateway.type);

			await runAuthInteractiveCommand({
				authConfig: lifecycle.authConfig,
				dependencies,
				io,
				provider,
				systemConfig,
				zoneId: selectedZone.id,
				...(dependencies.runCommand ? { runCommand: dependencies.runCommand } : {}),
			});
		},
	});
}
