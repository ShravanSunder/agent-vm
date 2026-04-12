// oxlint-disable typescript-eslint/explicit-function-return-type
import { flag, option, optional, restPositionals, string } from 'cmd-ts';
import { ZodError } from 'zod';

import type { SystemConfig } from '../../config/system-config.js';
import type { CliDependencies } from '../agent-vm-cli-support.js';
import { formatZodError } from '../format-zod-error.js';
import type { GatewayType } from '../init-command.js';

export function createConfigOption() {
	return option({
		type: optional(string),
		long: 'config',
		short: 'c',
		description: 'Path to system.json',
		defaultValue: () => 'system.json',
	});
}

export function createZoneOption() {
	return option({
		type: optional(string),
		long: 'zone',
		short: 'z',
		description: 'Zone identifier (lists available zones when omitted)',
	});
}

export function createConfirmFlag() {
	return flag({
		long: 'confirm',
		description: 'Confirm the destructive action',
	});
}

export function createPurgeFlag() {
	return flag({
		long: 'purge',
		description: 'Remove persisted zone state and workspaces',
	});
}

export function createPrintFlag() {
	return flag({
		long: 'print',
		description: 'Print the SSH command instead of opening a shell',
	});
}

export function createRemoteCommandArguments() {
	return restPositionals({
		displayName: 'remote-command',
		description: 'Command to run in the remote gateway shell',
	});
}

export function loadSystemConfigFromOption(
	configPath: string | undefined,
	dependencies: Pick<CliDependencies, 'loadSystemConfig'>,
): Promise<SystemConfig> {
	const resolvedConfigPath = configPath ?? 'system.json';
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

export function parseGatewayType(gatewayType: string | undefined): GatewayType {
	if (gatewayType === 'openclaw') {
		return gatewayType;
	}
	if (gatewayType === 'coding') {
		return gatewayType;
	}

	throw new Error(
		`Gateway type is required. Expected 'openclaw' or 'coding'${gatewayType ? `, got '${gatewayType}'` : ''}.`,
	);
}
