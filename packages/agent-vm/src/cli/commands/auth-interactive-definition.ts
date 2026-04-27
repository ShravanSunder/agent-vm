// oxlint-disable typescript-eslint/explicit-function-return-type
import { command, flag, positional, string } from 'cmd-ts';

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
		description: 'Run interactive auth for a gateway zone.',
		args: {
			config: createConfigOption(),
			deviceCode: flag({
				long: 'device-code',
				description: 'Use the provider device-code flow instead of browser callback auth.',
			}),
			provider: positional({
				displayName: 'provider',
				type: string,
				description: 'Provider name (for example: codex).',
			}),
			setDefault: flag({
				long: 'set-default',
				description: 'Set the provider as the default model auth target after login.',
			}),
			zone: createZoneOption(),
		},
		handler: async ({ config, deviceCode, provider, setDefault, zone }) => {
			const systemConfig = await loadSystemConfigFromOption(config, dependencies);
			const selectedZone = requireZone(systemConfig, zone);
			const lifecycle = loadGatewayLifecycle(selectedZone.gateway.type);

			await runAuthInteractiveCommand({
				authConfig: lifecycle.authConfig,
				dependencies,
				deviceCode,
				io,
				provider,
				setDefault,
				systemConfig,
				zoneId: selectedZone.id,
				...(dependencies.runCommand ? { runCommand: dependencies.runCommand } : {}),
			});
		},
	});
}
