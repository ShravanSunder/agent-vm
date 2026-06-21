// oxlint-disable typescript-eslint/explicit-function-return-type
import {
	array,
	command,
	flag,
	multioption,
	option,
	optional,
	positional,
	string,
	subcommands,
} from 'cmd-ts';

import { loadGatewayLifecycle } from '../../gateway/gateway-lifecycle-loader.js';
import { type CliDependencies, type CliIo, requireZone } from '../agent-vm-cli-support.js';
import { runCodexHarnessAuthCommand } from '../codex-harness-auth-command.js';
import { runOnePasswordAuthCommand } from '../onepassword-auth-command.js';
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
			'1password': command({
				name: '1password',
				description: 'Store the configured 1Password service-account token in macOS Keychain.',
				args: {
					config: createConfigOption(),
					tokenReference: positional({
						displayName: 'token-ref-or-url',
						type: optional(string),
						description: '1Password ref or URL to read with `op read`; omit to paste token.',
					}),
				},
				handler: async ({ config, tokenReference }) => {
					const systemConfig = await loadSystemConfigFromOption(config, dependencies);
					await runOnePasswordAuthCommand({
						dependencies,
						io,
						systemConfig,
						...(tokenReference === undefined ? {} : { tokenReference }),
					});
				},
			}),
			openclaw: subcommands({
				name: 'openclaw',
				description: 'Run OpenClaw-managed provider auth for a gateway zone.',
				cmds: {
					login: command({
						name: 'login',
						description: 'Create or refresh OpenClaw auth profiles for one provider.',
						args: {
							agent: option({
								type: optional(string),
								long: 'agent',
								description:
									'OpenClaw agent id whose isolated auth profile store should receive auth.',
							}),
							allConfiguredProfiles: flag({
								long: 'all-configured-profiles',
								description:
									'Login every profile id from gateway.authLogin.providers.<provider>.profileIds.',
							}),
							config: createConfigOption(),
							deviceCode: flag({
								long: 'device-code',
								description: 'Use the provider device-code flow instead of browser callback auth.',
							}),
							dryRun: flag({
								long: 'dry-run',
								description: 'Print the resolved login plan without opening SSH or changing auth.',
							}),
							profileIds: multioption({
								type: array(string),
								long: 'profile-id',
								description: 'Profile id to create or refresh. Can be passed more than once.',
								defaultValue: () => [],
							}),
							provider: positional({
								displayName: 'provider',
								type: string,
								description: 'Provider name (for example: openai).',
							}),
							zone: createZoneOption(),
						},
						handler: async ({
							agent,
							allConfiguredProfiles,
							config,
							deviceCode,
							dryRun,
							profileIds,
							provider,
							zone,
						}) => {
							const systemConfig = await loadSystemConfigFromOption(config, dependencies);
							const selectedZone = requireZone(systemConfig, zone);
							const lifecycle = loadGatewayLifecycle(selectedZone.gateway.type);

							await runOpenClawAuthCommand({
								...(agent ? { agentId: agent } : {}),
								allConfiguredProfiles,
								authConfig: lifecycle.authConfig,
								dependencies,
								deviceCode,
								dryRun,
								io,
								profileIds,
								provider,
								systemConfig,
								zoneId: selectedZone.id,
							});
						},
					}),
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
