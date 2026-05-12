// oxlint-disable typescript-eslint/explicit-function-return-type
import { command, flag, subcommands } from 'cmd-ts';

import { type CliDependencies, type CliIo, requireZone } from '../agent-vm-cli-support.js';
import { runZoneGitCommand, type ZoneGitCommandAction } from '../zone-git-commands.js';
import {
	createConfigOption,
	createZoneOption,
	loadSystemConfigFromOption,
} from './command-definition-support.js';

function createJsonFlag() {
	return flag({
		long: 'json',
		description: 'Print JSON output',
	});
}

function createZoneGitCommand(
	action: ZoneGitCommandAction,
	description: string,
	io: CliIo,
	dependencies: CliDependencies,
) {
	return command({
		name: action,
		description,
		args: {
			config: createConfigOption(),
			json: createJsonFlag(),
			zone: createZoneOption(),
		},
		handler: async ({ config, json, zone }) => {
			const systemConfig = await loadSystemConfigFromOption(config, dependencies);
			const selectedZone = requireZone(systemConfig, zone);
			await runZoneGitCommand({
				action,
				dependencies,
				io,
				json,
				systemConfig,
				zoneId: selectedZone.id,
			});
		},
	});
}

export function createZoneGitSubcommands(io: CliIo, dependencies: CliDependencies) {
	return subcommands({
		name: 'zone-git',
		description: 'Manage OpenClaw zone Git state',
		cmds: {
			init: createZoneGitCommand('init', 'Initialize OpenClaw zone Git metadata', io, dependencies),
			status: createZoneGitCommand('status', 'Show OpenClaw zone Git status', io, dependencies),
			push: createZoneGitCommand('push', 'Push committed OpenClaw zone changes', io, dependencies),
		},
	});
}
