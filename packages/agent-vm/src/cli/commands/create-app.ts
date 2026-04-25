// oxlint-disable typescript-eslint/explicit-function-return-type
import { subcommands } from 'cmd-ts';

import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { createAuthInteractiveCommand } from './auth-interactive-definition.js';
import { createBackupSubcommands } from './backup-definition.js';
import { createBuildCommand } from './build-definition.js';
import { createCacheSubcommands } from './cache-definition.js';
import { createConfigSubcommands } from './config-definition.js';
import { createControllerSubcommands } from './controller-definition.js';
import { createDoctorCommand } from './doctor-definition.js';
import { createInitCommand } from './init-definition.js';
import { createResourcesSubcommands } from './resources-definition.js';
import { createValidateCommand } from './validate-definition.js';

export function createAgentVmApp(io: CliIo, dependencies: CliDependencies) {
	return subcommands({
		name: 'agent-vm',
		version: '0.0.1',
		description: 'Gondolin-based VM controller for Worker and OpenClaw agents',
		cmds: {
			init: createInitCommand(io, dependencies),
			resources: createResourcesSubcommands(io, dependencies),
			build: createBuildCommand(io, dependencies),
			validate: createValidateCommand(io, dependencies),
			doctor: createDoctorCommand(io, dependencies),
			cache: createCacheSubcommands(io, dependencies),
			config: createConfigSubcommands(io, dependencies),
			backup: createBackupSubcommands(io, dependencies),
			'auth-interactive': createAuthInteractiveCommand(io, dependencies),
			controller: createControllerSubcommands(io, dependencies),
		},
	});
}
