import { object } from '@optique/core/constructs';
import { map, optional, withDefault } from '@optique/core/modifiers';
import type { Parser } from '@optique/core/parser';
import { command, option } from '@optique/core/primitives';
import { zod } from '@optique/zod';
import { z } from 'zod';

import { zoneIdSchema } from '../../config/system-config.js';
import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { writeJson } from '../agent-vm-cli-support.js';
import { updateAgentVmManual } from '../manual-commands.js';
import { cliDescription, createPresenceFlag } from './command-definition-support.js';

function writePathGroup(io: CliIo, label: string, paths: readonly string[]): void {
	for (const filePath of paths) {
		io.stdout.write(`  ${label} ${filePath}\n`);
	}
}

export interface ManualCommandOptions {
	readonly agents: boolean;
	readonly config: string;
	readonly defaultZone: string;
	readonly json: boolean;
	readonly targetDir: string | undefined;
}

export interface ManualCommand {
	readonly command: 'manual.update';
	readonly options: ManualCommandOptions;
}

export function createManualSubcommands(): Parser<'sync', ManualCommand> {
	return command(
		'manual',
		command(
			'update',
			map(
				object({
					agents: createPresenceFlag('--agents', 'Also refresh AGENTS.md and CLAUDE.md'),
					config: withDefault(
						option(
							'--config',
							zod(z.string(), { metavar: 'PATH', placeholder: 'config/system.jsonc' }),
							{
								description: cliDescription(
									'Deployment system config path documented in the manual',
								),
							},
						),
						'config/system.jsonc',
					),
					defaultZone: withDefault(
						option(
							'--default-zone',
							zod(zoneIdSchema, { metavar: 'ZONE_ID', placeholder: 'default' }),
							{
								description: cliDescription(
									'Default zone id to mention in generated agent instructions',
								),
							},
						),
						'default',
					),
					json: createPresenceFlag('--json', 'Print machine-readable JSON output'),
					targetDir: optional(
						option('--target-dir', zod(z.string(), { metavar: 'PATH', placeholder: '.' }), {
							description: cliDescription('Deployment directory to update'),
						}),
					),
				}),
				(options) => ({ command: 'manual.update' as const, options }),
			),
			{ description: cliDescription('Update generated agent-vm deployment manual files') },
		),
		{ description: cliDescription('Update generated deployment manual files') },
	);
}

export async function runManualCommand(
	io: CliIo,
	dependencies: CliDependencies,
	options: ManualCommandOptions,
): Promise<void> {
	const resolvedTargetDir =
		options.targetDir ?? dependencies.getCurrentWorkingDirectory?.() ?? process.cwd();
	const result = await (dependencies.updateAgentVmManual ?? updateAgentVmManual)({
		defaultZoneId: options.defaultZone,
		systemConfigPath: options.config,
		targetDir: resolvedTargetDir,
		updateAgentIndex: options.agents,
	});
	if (options.json) {
		writeJson(io, result);
		return;
	}
	io.stdout.write('Updated generated agent-vm manual files\n');
	writePathGroup(io, 'updated', result.updated);
}
