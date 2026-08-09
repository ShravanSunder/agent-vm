import { object, or } from '@optique/core/constructs';
import { map } from '@optique/core/modifiers';
import type { Parser } from '@optique/core/parser';
import { command } from '@optique/core/primitives';

import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { writeJson } from '../agent-vm-cli-support.js';
import {
	initRepoResources,
	type InitRepoResourcesResult,
	type UpdateRepoResourcesResult,
	updateRepoResources,
	validateRepoResources,
	type ValidateRepoResourcesResult,
} from '../resources-commands.js';
import { cliDescription, createPresenceFlag } from './command-definition-support.js';

function writePathGroup(io: CliIo, label: string, paths: readonly string[]): void {
	if (paths.length === 0) {
		return;
	}
	for (const filePath of paths) {
		io.stdout.write(`  ${label} ${filePath}\n`);
	}
}

function writeInitSummary(io: CliIo, targetDir: string, result: InitRepoResourcesResult): void {
	io.stdout.write(`Scaffolded .agent-vm resources in ${targetDir}\n`);
	writePathGroup(io, 'created', result.created);
	writePathGroup(io, 'updated', result.updated);
	writePathGroup(io, 'skipped', result.skipped);
	io.stdout.write(
		'Next: edit .agent-vm/repo-resources.ts and .agent-vm/docker-compose.yml, then run agent-vm resources validate.\n',
	);
}

function writeUpdateSummary(io: CliIo, result: UpdateRepoResourcesResult): void {
	io.stdout.write('Updated generated .agent-vm resource support files\n');
	writePathGroup(io, 'updated', result.updated);
}

function writeValidateSummary(
	io: CliIo,
	_targetDir: string,
	_result: ValidateRepoResourcesResult,
): void {
	io.stdout.write('Repo resource contract is valid.\n');
}

export type ResourcesCommand =
	| { readonly command: 'resources.init'; readonly options: { readonly json: boolean } }
	| { readonly command: 'resources.validate'; readonly options: { readonly json: boolean } }
	| { readonly command: 'resources.update'; readonly options: { readonly json: boolean } };

export function createResourcesSubcommands(): Parser<'sync', ResourcesCommand> {
	const createResourceCommand = (
		name: 'init' | 'validate' | 'update',
		description: string,
	): Parser<'sync', ResourcesCommand> =>
		command(
			name,
			map(
				object({
					json: createPresenceFlag('--json', 'Print machine-readable JSON output'),
				}),
				(options) => ({ command: `resources.${name}` as const, options }),
			),
			{ description: cliDescription(description) },
		);
	return command(
		'resources',
		or(
			createResourceCommand('init', 'Scaffold .agent-vm resource files in the current repo'),
			createResourceCommand('validate', 'Validate .agent-vm resource files in the current repo'),
			createResourceCommand('update', 'Update generated .agent-vm resource support files'),
		),
		{ description: cliDescription('Scaffold and validate repo resource files') },
	);
}

export async function runResourcesCommand(
	io: CliIo,
	dependencies: CliDependencies,
	commandValue: ResourcesCommand,
): Promise<void> {
	const targetDir = dependencies.getCurrentWorkingDirectory?.() ?? process.cwd();
	if (commandValue.command === 'resources.init') {
		const result = await (dependencies.initRepoResources ?? initRepoResources)({ targetDir });
		if (commandValue.options.json) {
			writeJson(io, result);
			return;
		}
		writeInitSummary(io, targetDir, result);
		return;
	}
	if (commandValue.command === 'resources.validate') {
		const result = await (dependencies.validateRepoResources ?? validateRepoResources)({
			targetDir,
		});
		if (commandValue.options.json) {
			writeJson(io, result);
			return;
		}
		writeValidateSummary(io, targetDir, result);
		return;
	}
	const result = await (dependencies.updateRepoResources ?? updateRepoResources)({ targetDir });
	if (commandValue.options.json) {
		writeJson(io, result);
		return;
	}
	writeUpdateSummary(io, result);
}
