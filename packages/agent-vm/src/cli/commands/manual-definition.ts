// oxlint-disable typescript-eslint/explicit-function-return-type
import { command, flag, option, optional, string, subcommands } from 'cmd-ts';

import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { writeJson } from '../agent-vm-cli-support.js';
import { updateAgentVmManual } from '../manual-commands.js';

function writePathGroup(io: CliIo, label: string, paths: readonly string[]): void {
	for (const filePath of paths) {
		io.stdout.write(`  ${label} ${filePath}\n`);
	}
}

export function createManualSubcommands(io: CliIo, dependencies: CliDependencies) {
	return subcommands({
		name: 'manual',
		description: 'Update generated deployment manual files',
		cmds: {
			update: command({
				name: 'update',
				description: 'Update generated agent-vm deployment manual files',
				args: {
					agents: flag({
						long: 'agents',
						description: 'Also refresh AGENTS.md and CLAUDE.md',
					}),
					config: option({
						type: optional(string),
						long: 'config',
						description: 'Deployment system config path documented in the manual',
						defaultValue: () => 'config/system.jsonc',
					}),
					defaultZone: option({
						type: optional(string),
						long: 'default-zone',
						description: 'Default zone id to mention in generated agent instructions',
						defaultValue: () => 'default',
					}),
					json: flag({
						long: 'json',
						description: 'Print machine-readable JSON output',
					}),
					targetDir: option({
						type: optional(string),
						long: 'target-dir',
						description: 'Deployment directory to update',
					}),
				},
				handler: async ({ agents, config, defaultZone, json, targetDir }) => {
					const resolvedTargetDir =
						targetDir ?? dependencies.getCurrentWorkingDirectory?.() ?? process.cwd();
					const result = await (dependencies.updateAgentVmManual ?? updateAgentVmManual)({
						defaultZoneId: defaultZone ?? 'default',
						systemConfigPath: config ?? 'config/system.jsonc',
						targetDir: resolvedTargetDir,
						updateAgentIndex: agents,
					});
					if (json) {
						writeJson(io, result);
						return;
					}
					io.stdout.write('Updated generated agent-vm manual files\n');
					writePathGroup(io, 'updated', result.updated);
				},
			}),
		},
	});
}
