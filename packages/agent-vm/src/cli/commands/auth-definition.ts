import { object, or } from '@optique/core/constructs';
import { map, multiple, optional } from '@optique/core/modifiers';
import type { Parser } from '@optique/core/parser';
import { argument, command, option } from '@optique/core/primitives';
import { zod } from '@optique/zod';
import { z } from 'zod';

import { agentIdSchema } from '../../config/system-config.js';
import { loadGatewayLifecycle } from '../../gateway/gateway-lifecycle-loader.js';
import { type CliDependencies, type CliIo, requireZone } from '../agent-vm-cli-support.js';
import { runCodexHarnessAuthCommand } from '../codex-harness-auth-command.js';
import { runOnePasswordAuthCommand } from '../onepassword-auth-command.js';
import { runOpenClawAuthCommand } from '../openclaw-auth-command.js';
import { cliDescription, createPresenceFlag } from './command-definition-support.js';
import {
	createConfigOption,
	createZoneOption,
	loadSystemConfigFromOption,
} from './command-definition-support.js';

interface AuthOnePasswordOptions {
	readonly config: string;
	readonly tokenReference: string | undefined;
}

interface AuthOpenClawLoginOptions {
	readonly agent: string | undefined;
	readonly allConfiguredProfiles: boolean;
	readonly config: string;
	readonly deviceCode: boolean;
	readonly dryRun: boolean;
	readonly profileIds: readonly string[];
	readonly provider: string;
	readonly zone: string | undefined;
}

interface AuthCodexHarnessOptions {
	readonly agent: string | undefined;
	readonly allAgents: boolean;
	readonly config: string;
	readonly zone: string | undefined;
}

export type AuthCommand =
	| { readonly command: 'auth.1password'; readonly options: AuthOnePasswordOptions }
	| { readonly command: 'auth.openclaw.login'; readonly options: AuthOpenClawLoginOptions }
	| { readonly command: 'auth.codex-harness'; readonly options: AuthCodexHarnessOptions };

export function createAuthSubcommands(): Parser<'sync', AuthCommand> {
	const onePassword = command(
		'1password',
		map(
			object({
				config: createConfigOption(),
				tokenReference: optional(
					argument(zod(z.string(), { metavar: 'TOKEN_REF_OR_URL', placeholder: 'op://...' }), {
						description: cliDescription(
							'1Password ref or URL to read with `op read`; omit to paste token.',
						),
					}),
				),
			}),
			(options) => ({ command: 'auth.1password' as const, options }),
		),
		{
			description: cliDescription(
				'Store the configured 1Password service-account token in macOS Keychain.',
			),
		},
	);
	const openclawLogin = command(
		'login',
		map(
			object({
				agent: optional(
					option('--agent', zod(agentIdSchema, { metavar: 'AGENT_ID', placeholder: 'main' }), {
						description: cliDescription(
							'OpenClaw agent id whose isolated auth profile store should receive auth.',
						),
					}),
				),
				allConfiguredProfiles: createPresenceFlag(
					'--all-configured-profiles',
					'Login every profile id from gateway.authLogin.providers.<provider>.profileIds.',
				),
				config: createConfigOption(),
				deviceCode: createPresenceFlag(
					'--device-code',
					'Use the provider device-code flow instead of browser callback auth.',
				),
				dryRun: createPresenceFlag(
					'--dry-run',
					'Print the resolved login plan without opening SSH or changing auth.',
				),
				profileIds: multiple(
					option(
						'--profile-id',
						zod(z.string(), { metavar: 'PROFILE_ID', placeholder: 'profile' }),
						{
							description: cliDescription(
								'Profile id to create or refresh. Can be passed more than once.',
							),
						},
					),
				),
				provider: argument(zod(z.string(), { metavar: 'PROVIDER', placeholder: 'openai' }), {
					description: cliDescription('Provider name (for example: openai).'),
				}),
				zone: createZoneOption(),
			}),
			(options) => ({ command: 'auth.openclaw.login' as const, options }),
		),
		{ description: cliDescription('Create or refresh OpenClaw auth profiles for one provider.') },
	);
	const openclaw = command('openclaw', openclawLogin, {
		description: cliDescription('Run OpenClaw-managed provider auth for a gateway zone.'),
	});
	const codexHarness = command(
		'codex-harness',
		map(
			object({
				agent: optional(
					option('--agent', zod(agentIdSchema, { metavar: 'AGENT_ID', placeholder: 'main' }), {
						description: cliDescription(
							'OpenClaw agent id whose isolated CODEX_HOME should receive auth.',
						),
					}),
				),
				allAgents: createPresenceFlag(
					'--all-agents',
					'Run native Codex CLI device auth once for every configured zone agent.',
				),
				config: createConfigOption(),
				zone: createZoneOption(),
			}),
			(options) => ({ command: 'auth.codex-harness' as const, options }),
		),
		{
			description: cliDescription(
				'Run native Codex CLI device auth for one or all OpenClaw agents.',
			),
		},
	);
	return command('auth', or(onePassword, openclaw, codexHarness), {
		description: cliDescription('Manage gateway auth.'),
	});
}

export async function runAuthCommand(
	io: CliIo,
	dependencies: CliDependencies,
	commandValue: AuthCommand,
): Promise<void> {
	if (commandValue.command === 'auth.1password') {
		const systemConfig = await loadSystemConfigFromOption(
			commandValue.options.config,
			dependencies,
		);
		await runOnePasswordAuthCommand({
			dependencies,
			io,
			systemConfig,
			...(commandValue.options.tokenReference === undefined
				? {}
				: { tokenReference: commandValue.options.tokenReference }),
		});
		return;
	}
	if (commandValue.command === 'auth.codex-harness') {
		const systemConfig = await loadSystemConfigFromOption(
			commandValue.options.config,
			dependencies,
		);
		const selectedZone = requireZone(systemConfig, commandValue.options.zone);
		await runCodexHarnessAuthCommand({
			...(commandValue.options.agent ? { agentId: commandValue.options.agent } : {}),
			allAgents: commandValue.options.allAgents,
			dependencies,
			io,
			systemConfig,
			zone: selectedZone,
		});
		return;
	}
	const systemConfig = await loadSystemConfigFromOption(commandValue.options.config, dependencies);
	const selectedZone = requireZone(systemConfig, commandValue.options.zone);
	if (selectedZone.gateway.type !== 'openclaw') {
		throw new Error(`Zone '${selectedZone.id}' does not support OpenClaw auth login.`);
	}
	const lifecycle = loadGatewayLifecycle(selectedZone.gateway.type);
	await runOpenClawAuthCommand({
		...(commandValue.options.agent ? { agentId: commandValue.options.agent } : {}),
		allConfiguredProfiles: commandValue.options.allConfiguredProfiles,
		authConfig: lifecycle.authConfig,
		dependencies,
		deviceCode: commandValue.options.deviceCode,
		dryRun: commandValue.options.dryRun,
		io,
		profileIds: commandValue.options.profileIds,
		provider: commandValue.options.provider,
		systemConfig,
		zoneId: selectedZone.id,
	});
}
