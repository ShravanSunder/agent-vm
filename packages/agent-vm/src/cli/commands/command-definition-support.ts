import type { OptionName } from '@optique/core';
import { message, type Message } from '@optique/core/message';
import { optional, withDefault } from '@optique/core/modifiers';
import type { Parser } from '@optique/core/parser';
import { flag, option } from '@optique/core/primitives';
import { ZodError } from 'zod';

import type { LoadedSystemConfig } from '../../config/system-config.js';
import type { CliDependencies } from '../agent-vm-cli-support.js';
import { formatZodError } from '../format-zod-error.js';
import { createConfigPathValueParser, createZoneIdValueParser } from '../optique-cli-support.js';

export function cliDescription(description: string): Message {
	return message`${description}`;
}

export function createConfigOption(): Parser<'sync', string> {
	return withDefault(
		option('-c', '--config', createConfigPathValueParser(), {
			description: cliDescription('Path to config/system.jsonc or config/system.json'),
		}),
		'config/system.json',
	);
}

export function createZoneOption(): Parser<'sync', string | undefined> {
	return optional(
		option('-z', '--zone', createZoneIdValueParser(), {
			description: cliDescription('Zone identifier (lists available zones when omitted)'),
		}),
	);
}

export function createPresenceFlag(name: OptionName, description: string): Parser<'sync', boolean> {
	return withDefault(flag(name, { description: cliDescription(description) }), false);
}

export function createConfirmFlag(): Parser<'sync', boolean> {
	return createPresenceFlag('--confirm', 'Confirm the destructive action');
}

export function createPurgeFlag(): Parser<'sync', boolean> {
	return createPresenceFlag('--purge', 'Remove persisted zone state and workspaces');
}

export function loadSystemConfigFromOption(
	configPath: string | undefined,
	dependencies: Pick<CliDependencies, 'loadSystemConfig'>,
): Promise<LoadedSystemConfig> {
	const resolvedConfigPath = configPath ?? 'config/system.json';
	return dependencies.loadSystemConfig(resolvedConfigPath).catch((error: unknown) => {
		if (error instanceof ZodError) {
			throw new Error(formatZodError(`Invalid ${resolvedConfigPath} configuration:`, error), {
				cause: error,
			});
		}
		if (error instanceof SyntaxError) {
			throw new Error(`Invalid JSON in ${resolvedConfigPath}: ${error.message}`, {
				cause: error,
			});
		}
		throw error;
	});
}

export function appendZoneArgument(arguments_: string[], zoneId: string): readonly string[] {
	return [...arguments_, '--zone', zoneId];
}
