import { argument, command, constant, object, option } from '@optique/core';
import { zod } from '@optique/zod';
import { z } from 'zod';

import { agentIdSchema, projectNamespaceSchema, zoneIdSchema } from '../../config/system-config.js';
import { projectZodScalarPresence } from '../agent-vm-parser-support.js';
import {
	imageArchitectureSchema,
	scaffoldGatewayTypeSchema,
	scaffoldPathModeSchema,
	secretsProviderSchema,
} from '../init-command-schemas.js';
import { cliDescription, createPresenceFlag } from './command-definition-support.js';

const initPresets = {
	'macos-local': {
		architecture: 'aarch64',
		hostSystemType: 'bare-metal',
		paths: 'user-dir',
		secretsProvider: '1password',
		writeLocalEnvironmentFile: true,
	},
	'container-x86': {
		architecture: 'x86_64',
		hostSystemType: 'container',
		paths: 'pod',
		secretsProvider: 'environment',
		writeLocalEnvironmentFile: false,
	},
	'container-arm64': {
		architecture: 'aarch64',
		hostSystemType: 'container',
		paths: 'pod',
		secretsProvider: 'environment',
		writeLocalEnvironmentFile: false,
	},
} as const;

export const initPresetSchema = z
	.enum(['macos-local', 'container-x86', 'container-arm64'])
	.transform((presetName) => initPresets[presetName])
	.optional();
export const initZoneIdSchema = zoneIdSchema.default('default');
export const initSecretsProviderSchema = secretsProviderSchema.optional();
export const initImageArchitectureSchema = imageArchitectureSchema.optional();
export const initPathModeSchema = scaffoldPathModeSchema.optional();
export const initProjectNamespaceSchema = projectNamespaceSchema.optional();
export const initOnePasswordAccountNameSchema = z.string().min(1).optional();
export const openClawAgentsSchema = z
	.string()
	.transform((value) =>
		value
			.split(',')
			.map((agentId) => agentId.trim())
			.filter((agentId) => agentId.length > 0),
	)
	.superRefine((agentIds, context) => {
		if (agentIds.length === 0) {
			context.addIssue({
				code: 'custom',
				message: '--openclaw-agents must include at least one non-empty agent id.',
			});
			return;
		}
		for (const agentId of agentIds) {
			const result = agentIdSchema.safeParse(agentId);
			if (!result.success) {
				context.addIssue({
					code: 'custom',
					message: `Invalid --openclaw-agents value '${agentId}': ${result.error.issues[0]?.message ?? 'invalid agent id'}`,
				});
			}
		}
	})
	.transform((agentIds) => Array.from(new Set(agentIds)))
	.optional();

export function parseAgentIds(agentIds: string): readonly string[] {
	return openClawAgentsSchema.unwrap().parse(agentIds);
}

export const initCommandParser = command(
	'init',
	object({
		command: constant('init'),
		options: object({
			zoneId: projectZodScalarPresence({
				parser: argument(
					zod(initZoneIdSchema, {
						metavar: 'ZONE_ID',
						placeholder: initZoneIdSchema.parse(undefined),
					}),
					{
						description: cliDescription('Zone identifier'),
					},
				),
				schema: initZoneIdSchema,
			}),
			type: projectZodScalarPresence({
				parser: option(
					'--type',
					zod(scaffoldGatewayTypeSchema, { metavar: 'TYPE', placeholder: 'openclaw' as const }),
					{ description: cliDescription('Gateway type: openclaw or worker') },
				),
				schema: scaffoldGatewayTypeSchema,
			}),
			preset: projectZodScalarPresence({
				parser: option(
					'--preset',
					zod(initPresetSchema, { metavar: 'PRESET', placeholder: undefined }),
					{
						description: cliDescription(
							'Deployment preset: macos-local, container-x86, or container-arm64',
						),
					},
				),
				schema: initPresetSchema,
			}),
			secrets: projectZodScalarPresence({
				parser: option(
					'--secrets',
					zod(initSecretsProviderSchema, { metavar: 'PROVIDER', placeholder: undefined }),
					{ description: cliDescription('Secrets provider: 1password or environment') },
				),
				schema: initSecretsProviderSchema,
			}),
			arch: projectZodScalarPresence({
				parser: option(
					'--arch',
					zod(initImageArchitectureSchema, { metavar: 'ARCH', placeholder: undefined }),
					{ description: cliDescription('VM image architecture: aarch64 or x86_64') },
				),
				schema: initImageArchitectureSchema,
			}),
			paths: projectZodScalarPresence({
				parser: option(
					'--paths',
					zod(initPathModeSchema, { metavar: 'PATHS', placeholder: undefined }),
					{ description: cliDescription('Path profile: local, pod, or user-dir') },
				),
				schema: initPathModeSchema,
			}),
			namespace: projectZodScalarPresence({
				parser: option(
					'--namespace',
					zod(initProjectNamespaceSchema, { metavar: 'NAMESPACE', placeholder: undefined }),
					{ description: cliDescription('Project namespace override') },
				),
				schema: initProjectNamespaceSchema,
			}),
			overwrite: createPresenceFlag('--overwrite', 'Overwrite existing scaffolded files'),
			agents: projectZodScalarPresence({
				parser: option(
					'--openclaw-agents',
					zod(openClawAgentsSchema, { metavar: 'AGENTS', placeholder: undefined }),
					{ description: cliDescription('Comma-separated OpenClaw agent ids') },
				),
				schema: openClawAgentsSchema,
			}),
			onePasswordKeychainAccountName: projectZodScalarPresence({
				parser: option(
					'--onepassword-keychain-account-name',
					zod(initOnePasswordAccountNameSchema, { metavar: 'ACCOUNT', placeholder: undefined }),
					{
						description: cliDescription(
							'Keychain account suffix for the 1Password service account token',
						),
					},
				),
				schema: initOnePasswordAccountNameSchema,
			}),
		}),
	}),
	{ description: cliDescription('Scaffold a new agent-vm project') },
);
