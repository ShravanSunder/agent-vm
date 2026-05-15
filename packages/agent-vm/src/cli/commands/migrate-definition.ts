// oxlint-disable typescript-eslint/explicit-function-return-type
import { command, subcommands } from 'cmd-ts';

import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { runMigrateImagesCommand, runMigrateMcpPortalConfigCommand } from '../migrate-commands.js';
import { createConfigOption } from './command-definition-support.js';

export function createMigrateSubcommands(io: CliIo, _dependencies: CliDependencies) {
	return subcommands({
		name: 'migrate',
		description: 'Migrate deployment-owned config to current agent-vm shapes',
		cmds: {
			images: command({
				name: 'images',
				description: 'Migrate legacy Dockerfile image profiles to managed base overlays',
				args: {
					config: createConfigOption(),
				},
				handler: async ({ config }) => {
					const result = await runMigrateImagesCommand({
						systemConfigPath: config ?? 'config/system.json',
					});
					io.stdout.write(
						`migrated image profiles: ${result.migratedProfiles.length === 0 ? 'none' : result.migratedProfiles.join(', ')}\n`,
					);
					if (result.skippedProfiles.length > 0) {
						io.stdout.write(`skipped image profiles: ${result.skippedProfiles.join(', ')}\n`);
					}
				},
			}),
			'mcp-portal': command({
				name: 'mcp-portal',
				description: 'Migrate OpenClaw MCP Portal config to standalone portal config files',
				args: {
					config: createConfigOption(),
				},
				handler: async ({ config }) => {
					const result = await runMigrateMcpPortalConfigCommand({
						systemConfigPath: config ?? 'config/system.json',
					});
					io.stdout.write(
						`migrated MCP portal zones: ${result.migratedZones.length === 0 ? 'none' : result.migratedZones.join(', ')}\n`,
					);
					if (result.createdFiles.length > 0) {
						io.stdout.write(`created MCP config files: ${result.createdFiles.join(', ')}\n`);
					}
					if (result.skippedZones.length > 0) {
						io.stdout.write(`skipped MCP portal zones: ${result.skippedZones.join(', ')}\n`);
					}
				},
			}),
		},
	});
}
