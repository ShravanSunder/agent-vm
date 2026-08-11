import { command, constant, object, option } from '@optique/core';
import { zod } from '@optique/zod';
import { z } from 'zod';

import { zoneIdSchema } from '../../config/system-config.js';
import { projectZodScalarPresence } from '../agent-vm-parser-support.js';
import { cliDescription, createPresenceFlag } from './command-definition-support.js';

const manualConfigPathSchema = z.string().min(1).default('config/system.jsonc');
const manualDefaultZoneSchema = zoneIdSchema.default('default');
const manualTargetDirectorySchema = z.string().min(1).optional();

export const manualCommandParser = command(
	'manual',
	command(
		'update',
		object({
			command: constant('manual.update'),
			options: object({
				agents: createPresenceFlag('--agents', 'Also refresh AGENTS.md and CLAUDE.md'),
				config: projectZodScalarPresence({
					parser: option(
						'--config',
						zod(manualConfigPathSchema, {
							metavar: 'PATH',
							placeholder: manualConfigPathSchema.parse(undefined),
						}),
						{
							description: cliDescription('Deployment system config path documented in the manual'),
						},
					),
					schema: manualConfigPathSchema,
				}),
				defaultZone: projectZodScalarPresence({
					parser: option(
						'--default-zone',
						zod(manualDefaultZoneSchema, {
							metavar: 'ZONE_ID',
							placeholder: manualDefaultZoneSchema.parse(undefined),
						}),
						{
							description: cliDescription(
								'Default zone id to mention in generated agent instructions',
							),
						},
					),
					schema: manualDefaultZoneSchema,
				}),
				json: createPresenceFlag('--json', 'Print machine-readable JSON output'),
				targetDir: projectZodScalarPresence({
					parser: option(
						'--target-dir',
						zod(manualTargetDirectorySchema, { metavar: 'PATH', placeholder: undefined }),
						{ description: cliDescription('Deployment directory to update') },
					),
					schema: manualTargetDirectorySchema,
				}),
			}),
		}),
		{ description: cliDescription('Update generated agent-vm deployment manual files') },
	),
	{ description: cliDescription('Update generated deployment manual files') },
);
