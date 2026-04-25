// oxlint-disable typescript-eslint/explicit-function-return-type
import { command, option, optional, string, subcommands } from 'cmd-ts';

import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { resetWorkerInstructions, type InstructionResetPhase } from '../config-commands.js';
import { createConfigOption, loadSystemConfigFromOption } from './command-definition-support.js';

function parseInstructionResetPhase(value: string): InstructionResetPhase {
	if (value === 'plan' || value === 'work' || value === 'wrapup' || value === 'all') {
		return value;
	}
	throw new Error(`Invalid --phase '${value}'. Expected 'plan', 'work', 'wrapup', or 'all'.`);
}

export function createConfigSubcommands(io: CliIo, dependencies: CliDependencies) {
	return subcommands({
		name: 'config',
		description: 'Edit agent-vm configuration files',
		cmds: {
			'reset-instructions': command({
				name: 'reset-instructions',
				description: 'Reset scaffolded worker instruction fields to current defaults',
				args: {
					config: createConfigOption(),
					zone: option({
						type: optional(string),
						long: 'zone',
						description: 'Zone identifier. Required when system config has multiple zones.',
					}),
					phase: option({
						type: string,
						long: 'phase',
						description: 'Instruction phase to reset: plan, work, wrapup, or all',
						defaultValue: () => 'all',
					}),
				},
				handler: async ({ config, phase, zone }) => {
					const systemConfig = await loadSystemConfigFromOption(config, dependencies);
					let selectedZone: (typeof systemConfig.zones)[number] | undefined;
					if (zone !== undefined) {
						selectedZone = systemConfig.zones.find((candidateZone) => candidateZone.id === zone);
					} else if (systemConfig.zones.length === 1) {
						selectedZone = systemConfig.zones[0];
					}
					if (!selectedZone) {
						throw new Error(
							zone === undefined
								? 'Multiple zones configured; pass --zone <zone-id>.'
								: `Unknown zone '${zone}'.`,
						);
					}
					if (selectedZone.gateway.type !== 'worker') {
						throw new Error(
							`Zone '${selectedZone.id}' uses gateway type '${selectedZone.gateway.type}'; reset-instructions only supports worker gateways.`,
						);
					}
					const result = await (dependencies.resetWorkerInstructions ?? resetWorkerInstructions)({
						workerConfigPath: selectedZone.gateway.config,
						phase: parseInstructionResetPhase(phase),
					});
					io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
				},
			}),
		},
	});
}
