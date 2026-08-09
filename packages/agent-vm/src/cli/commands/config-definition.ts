import { object } from '@optique/core/constructs';
import { map, optional, withDefault } from '@optique/core/modifiers';
import type { Parser } from '@optique/core/parser';
import { command, option } from '@optique/core/primitives';
import { zod } from '@optique/zod';
import { z } from 'zod';

import { zoneIdSchema } from '../../config/system-config.js';
import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { resetWorkerInstructions, type InstructionResetPhase } from '../config-commands.js';
import { cliDescription } from './command-definition-support.js';
import { createConfigOption, loadSystemConfigFromOption } from './command-definition-support.js';

const instructionResetPhaseSchema = z.enum(['plan', 'work', 'wrapup', 'all']);

export interface ConfigCommandOptions {
	readonly config: string;
	readonly zone: string | undefined;
	readonly phase: InstructionResetPhase;
}

export interface ConfigCommand {
	readonly command: 'config.reset-instructions';
	readonly options: ConfigCommandOptions;
}

export function createConfigSubcommands(): Parser<'sync', ConfigCommand> {
	return command(
		'config',
		command(
			'reset-instructions',
			map(
				object({
					config: createConfigOption(),
					zone: optional(
						option('--zone', zod(zoneIdSchema, { metavar: 'ZONE_ID', placeholder: 'zone-id' }), {
							description: cliDescription(
								'Zone identifier. Required when system config has multiple zones.',
							),
						}),
					),
					phase: withDefault(
						option(
							'--phase',
							zod<InstructionResetPhase>(instructionResetPhaseSchema, {
								metavar: 'PHASE',
								placeholder: 'all',
							}),
							{
								description: cliDescription(
									'Instruction phase to reset: plan, work, wrapup, or all',
								),
							},
						),
						'all' as const,
					),
				}),
				(options) => ({ command: 'config.reset-instructions' as const, options }),
			),
			{
				description: cliDescription(
					'Reset scaffolded worker instruction fields to current defaults',
				),
			},
		),
		{ description: cliDescription('Edit agent-vm configuration files') },
	);
}

export async function runConfigCommand(
	io: CliIo,
	dependencies: CliDependencies,
	options: ConfigCommandOptions,
): Promise<void> {
	const systemConfig = await loadSystemConfigFromOption(options.config, dependencies);
	let selectedZone: (typeof systemConfig.zones)[number] | undefined;
	if (options.zone !== undefined) {
		selectedZone = systemConfig.zones.find((candidateZone) => candidateZone.id === options.zone);
	} else if (systemConfig.zones.length === 1) {
		selectedZone = systemConfig.zones[0];
	}
	if (!selectedZone) {
		throw new Error(
			options.zone === undefined
				? 'Multiple zones configured; pass --zone <zone-id>.'
				: `Unknown zone '${options.zone}'.`,
		);
	}
	if (selectedZone.gateway.type !== 'worker') {
		throw new Error(
			`Zone '${selectedZone.id}' uses gateway type '${selectedZone.gateway.type}'; reset-instructions only supports worker gateways.`,
		);
	}
	const result = await (dependencies.resetWorkerInstructions ?? resetWorkerInstructions)({
		workerConfigPath: selectedZone.gateway.config,
		phase: options.phase,
	});
	io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
