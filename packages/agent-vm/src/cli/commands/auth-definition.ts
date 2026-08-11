import { argument, command, constant, object, option, or } from '@optique/core';
import { zod } from '@optique/zod';
import { z } from 'zod';

import { agentIdSchema } from '../../config/system-config-identifier-schemas.js';
import { projectZodRepeatedOption, projectZodScalarPresence } from '../agent-vm-parser-support.js';
import {
	cliDescription,
	createConfigOption,
	createPresenceFlag,
	createZoneOption,
} from './command-definition-support.js';

const tokenReferenceSchema = z.string().min(1).optional();
const optionalAgentIdSchema = agentIdSchema.optional();
const providerSchema = z.string().min(1);
const profileIdSchema = z.string().min(1);
export const authenticationProfileIdsSchema = z.array(profileIdSchema).default([]);

const onePasswordParser = command(
	'1password',
	object({
		command: constant('auth.1password'),
		options: object({
			config: createConfigOption(),
			tokenReference: projectZodScalarPresence({
				parser: argument(
					zod(tokenReferenceSchema, { metavar: 'TOKEN_REF_OR_URL', placeholder: undefined }),
					{ description: cliDescription('1Password ref or URL; omit to paste token') },
				),
				schema: tokenReferenceSchema,
			}),
		}),
	}),
	{
		description: cliDescription(
			'Store the configured 1Password service-account token in macOS Keychain',
		),
	},
);

const openClawLoginParser = command(
	'login',
	object({
		command: constant('auth.openclaw.login'),
		options: object({
			agent: projectZodScalarPresence({
				parser: option(
					'--agent',
					zod(optionalAgentIdSchema, { metavar: 'AGENT_ID', placeholder: undefined }),
				),
				schema: optionalAgentIdSchema,
			}),
			allConfiguredProfiles: createPresenceFlag(
				'--all-configured-profiles',
				'Login every configured profile id',
			),
			config: createConfigOption(),
			deviceCode: createPresenceFlag('--device-code', 'Use the provider device-code flow'),
			dryRun: createPresenceFlag('--dry-run', 'Print the resolved login plan'),
			profileIds: projectZodRepeatedOption({
				parser: option(
					'--profile-id',
					zod(authenticationProfileIdsSchema.unwrap().element, {
						metavar: 'PROFILE_ID',
						placeholder: 'profile',
					}),
				),
				schema: authenticationProfileIdsSchema,
			}),
			provider: argument(zod(providerSchema, { metavar: 'PROVIDER', placeholder: 'openai' })),
			zone: createZoneOption(),
		}),
	}),
	{ description: cliDescription('Create or refresh OpenClaw auth profiles for one provider') },
);

const codexHarnessParser = command(
	'codex-harness',
	object({
		command: constant('auth.codex-harness'),
		options: object({
			agent: projectZodScalarPresence({
				parser: option(
					'--agent',
					zod(optionalAgentIdSchema, { metavar: 'AGENT_ID', placeholder: undefined }),
				),
				schema: optionalAgentIdSchema,
			}),
			allAgents: createPresenceFlag(
				'--all-agents',
				'Run native Codex CLI device auth for every configured zone agent',
			),
			config: createConfigOption(),
			zone: createZoneOption(),
		}),
	}),
	{
		description: cliDescription('Run native Codex CLI device auth for one or all OpenClaw agents'),
	},
);

export const authCommandParser = command(
	'auth',
	or(
		onePasswordParser,
		command('openclaw', openClawLoginParser, {
			description: cliDescription('Run OpenClaw-managed provider auth'),
		}),
		codexHarnessParser,
	),
	{ description: cliDescription('Manage gateway auth') },
);
