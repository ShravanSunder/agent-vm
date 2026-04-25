// oxlint-disable typescript-eslint/explicit-function-return-type
import { command, flag, subcommands } from 'cmd-ts';

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

function createJsonFlag() {
	return flag({
		long: 'json',
		description: 'Print machine-readable JSON output',
	});
}

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

export function createResourcesSubcommands(io: CliIo, dependencies: CliDependencies) {
	return subcommands({
		name: 'resources',
		description: 'Scaffold and validate repo resource files',
		cmds: {
			init: command({
				name: 'init',
				description: 'Scaffold .agent-vm resource files in the current repo',
				args: {
					json: createJsonFlag(),
				},
				handler: async ({ json }) => {
					const targetDir = dependencies.getCurrentWorkingDirectory?.() ?? process.cwd();
					const result = await (dependencies.initRepoResources ?? initRepoResources)({ targetDir });
					if (json) {
						writeJson(io, result);
						return;
					}
					writeInitSummary(io, targetDir, result);
				},
			}),
			validate: command({
				name: 'validate',
				description: 'Validate .agent-vm resource files in the current repo',
				args: {
					json: createJsonFlag(),
				},
				handler: async ({ json }) => {
					const targetDir = dependencies.getCurrentWorkingDirectory?.() ?? process.cwd();
					const result = await (dependencies.validateRepoResources ?? validateRepoResources)({
						targetDir,
					});
					if (json) {
						writeJson(io, result);
						return;
					}
					writeValidateSummary(io, targetDir, result);
				},
			}),
			update: command({
				name: 'update',
				description: 'Update generated .agent-vm resource support files',
				args: {
					json: createJsonFlag(),
				},
				handler: async ({ json }) => {
					const targetDir = dependencies.getCurrentWorkingDirectory?.() ?? process.cwd();
					const result = await (dependencies.updateRepoResources ?? updateRepoResources)({
						targetDir,
					});
					if (json) {
						writeJson(io, result);
						return;
					}
					writeUpdateSummary(io, result);
				},
			}),
		},
	});
}
