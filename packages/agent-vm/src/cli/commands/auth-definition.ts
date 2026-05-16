// oxlint-disable typescript-eslint/explicit-function-return-type
import { command, flag, option, optional, positional, string, subcommands } from 'cmd-ts';

import { loadGatewayLifecycle } from '../../gateway/gateway-lifecycle-loader.js';
import { type CliDependencies, type CliIo, requireZone } from '../agent-vm-cli-support.js';
import { runCodexHarnessAuthCommand } from '../codex-harness-auth-command.js';
import { runOpenClawAuthCommand } from '../openclaw-auth-command.js';
import {
	createConfigOption,
	createZoneOption,
	loadSystemConfigFromOption,
} from './command-definition-support.js';

export function createAuthSubcommands(io: CliIo, dependencies: CliDependencies) {
	return subcommands({
		name: 'auth',
		description: 'Manage gateway auth.',
		cmds: {
			openclaw: command({
				name: 'openclaw',
				description: 'Run OpenClaw-managed provider auth for a gateway zone.',
				args: {
					config: createConfigOption(),
					deviceCode: flag({
						long: 'device-code',
						description: 'Use the provider device-code flow instead of browser callback auth.',
					}),
					provider: positional({
						displayName: 'provider',
						type: string,
						description: 'Provider name (for example: openai).',
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

					await runOpenClawAuthCommand({
						authConfig: lifecycle.authConfig,
						dependencies,
						deviceCode,
						io,
						provider,
						setDefault,
						systemConfig,
						zoneId: selectedZone.id,
					});
				},
			}),
			'codex-harness': command({
				name: 'codex-harness',
				description: 'Run native Codex CLI device auth for one or all OpenClaw agents.',
				args: {
					agent: option({
						type: optional(string),
						long: 'agent',
						description: 'OpenClaw agent id whose isolated CODEX_HOME should receive auth.',
					}),
					allAgents: flag({
						long: 'all-agents',
						description: 'Run native Codex CLI device auth once for every configured zone agent.',
					}),
					config: createConfigOption(),
					zone: createZoneOption(),
				},
				handler: async ({ agent, allAgents, config, zone }) => {
					const systemConfig = await loadSystemConfigFromOption(config, dependencies);
					const selectedZone = requireZone(systemConfig, zone);
					await runCodexHarnessAuthCommand({
						...(agent ? { agentId: agent } : {}),
						allAgents,
						dependencies,
						io,
						systemConfig,
						zone: selectedZone,
					});
				},
			}),
		},
	});
}
