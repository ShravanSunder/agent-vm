import { command, constant, object, option } from '@optique/core';
import { zod } from '@optique/zod';
import { z } from 'zod';

import { zoneIdSchema } from '../../config/system-config.js';
import { projectZodScalarPresence } from '../agent-vm-parser-support.js';
import { cliDescription, createConfigOption } from './command-definition-support.js';

export const instructionResetPhaseSchema = z.enum(['plan', 'work', 'wrapup', 'all']).default('all');
const optionalResetZoneSchema = zoneIdSchema.optional();

export const configCommandParser = command(
	'config',
	command(
		'reset-instructions',
		object({
			command: constant('config.reset-instructions'),
			options: object({
				config: createConfigOption(),
				zone: projectZodScalarPresence({
					parser: option(
						'--zone',
						zod(optionalResetZoneSchema, { metavar: 'ZONE_ID', placeholder: undefined }),
						{
							description: cliDescription(
								'Zone identifier. Required when system config has multiple zones.',
							),
						},
					),
					schema: optionalResetZoneSchema,
				}),
				phase: projectZodScalarPresence({
					parser: option(
						'--phase',
						zod(instructionResetPhaseSchema, {
							metavar: 'PHASE',
							placeholder: instructionResetPhaseSchema.parse(undefined),
						}),
						{
							description: cliDescription('Instruction phase to reset: plan, work, wrapup, or all'),
						},
					),
					schema: instructionResetPhaseSchema,
				}),
			}),
		}),
		{
			description: cliDescription('Reset scaffolded worker instruction fields to current defaults'),
		},
	),
	{ description: cliDescription('Edit agent-vm configuration files') },
);
