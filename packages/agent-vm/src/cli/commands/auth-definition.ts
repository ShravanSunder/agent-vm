import { argument, command, constant, object } from '@optique/core';
import { zod } from '@optique/zod';
import { z } from 'zod';

import { projectZodScalarPresence } from '../agent-vm-parser-support.js';
import { cliDescription, createConfigOption } from './command-definition-support.js';

const tokenReferenceSchema = z.string().min(1).optional();

const onePasswordParser = command(
	'1password',
	object({
		command: constant('auth.1password'),
		options: object({
			config: createConfigOption(),
			tokenReference: projectZodScalarPresence({
				parser: argument(
					zod(tokenReferenceSchema, { metavar: 'TOKEN_REF_OR_URL', placeholder: undefined }),
					{
						description: cliDescription(
							'1Password ref or URL to read with `op read`; omit to paste token.',
						),
					},
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

export const authCommandParser = command('auth', onePasswordParser, {
	description: cliDescription('Manage gateway auth'),
});
