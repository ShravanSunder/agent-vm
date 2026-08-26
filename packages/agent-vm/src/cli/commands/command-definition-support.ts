import {
	flag,
	option,
	text,
	withDefault,
	type Message,
	type OptionName,
	type Parser,
} from '@optique/core';
import { zod } from '@optique/zod';
import { z } from 'zod';

import { zoneIdSchema } from '../../config/system-config-identifier-schemas.js';
import { projectZodScalarPresence } from '../agent-vm-parser-support.js';

export const systemConfigPathSchema = z.string().min(1).default('config/system.json');
export const optionalZoneIdSchema = zoneIdSchema.optional();

export function cliDescription(description: string): Message {
	return [text(description)];
}

export function createConfigOption(): Parser<
	'sync',
	z.infer<typeof systemConfigPathSchema>,
	unknown
> {
	return projectZodScalarPresence({
		parser: option(
			'-c',
			'--config',
			zod(systemConfigPathSchema, {
				metavar: 'PATH',
				placeholder: systemConfigPathSchema.parse(undefined),
			}),
			{ description: cliDescription('Path to config/system.jsonc or config/system.json') },
		),
		schema: systemConfigPathSchema,
	});
}

export function createZoneOption(): Parser<'sync', z.infer<typeof optionalZoneIdSchema>, unknown> {
	return projectZodScalarPresence({
		parser: option(
			'-z',
			'--zone',
			zod(optionalZoneIdSchema, { metavar: 'ZONE_ID', placeholder: undefined }),
			{ description: cliDescription('Zone identifier (lists available zones when omitted)') },
		),
		schema: optionalZoneIdSchema,
	});
}

export function createPresenceFlag(name: OptionName, description: string): Parser<'sync', boolean> {
	return withDefault(flag(name, { description: cliDescription(description) }), false);
}

const requiredStringOptionSchema = z.string().min(1);

export function createRequiredStringOption(options: {
	readonly description: string;
	readonly metavar: 'AGENT_ID' | 'RUNTIME_ID';
	readonly name: OptionName;
}): Parser<'sync', z.infer<typeof requiredStringOptionSchema>, unknown> {
	return projectZodScalarPresence({
		parser: option(
			options.name,
			zod(requiredStringOptionSchema, { metavar: options.metavar, placeholder: 'value' }),
			{ description: cliDescription(options.description) },
		),
		schema: requiredStringOptionSchema,
	});
}

export function createConfirmFlag(): Parser<'sync', boolean> {
	return createPresenceFlag('--confirm', 'Confirm the destructive action');
}

export function createPurgeFlag(): Parser<'sync', boolean> {
	return createPresenceFlag('--purge', 'Remove persisted zone state and workspaces');
}
