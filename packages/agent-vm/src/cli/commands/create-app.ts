import { or } from '@optique/core/constructs';
import type { Parser } from '@optique/core/parser';

import { createAuthSubcommands, type AuthCommand } from './auth-definition.js';
import { createBackupSubcommands, type BackupCommand } from './backup-definition.js';
import { createBuildCommand, type BuildCommand } from './build-definition.js';
import { createCacheSubcommands, type CacheCommand } from './cache-definition.js';
import { createConfigSubcommands, type ConfigCommand } from './config-definition.js';
import { createControllerSubcommands, type ControllerCommand } from './controller-definition.js';
import { createDoctorCommand, type DoctorCommand } from './doctor-definition.js';
import { createInitCommand, type InitCommand } from './init-definition.js';
import { createManualSubcommands, type ManualCommand } from './manual-definition.js';
import { createMigrateSubcommands, type MigrateCommand } from './migrate-definition.js';
import { createPathsSubcommands, type PathsCommand } from './paths-definition.js';
import { createResourcesSubcommands, type ResourcesCommand } from './resources-definition.js';
import { createValidateCommand, type ValidateCommand } from './validate-definition.js';

export type AgentVmCommand =
	| InitCommand
	| ManualCommand
	| MigrateCommand
	| ResourcesCommand
	| BuildCommand
	| ValidateCommand
	| DoctorCommand
	| CacheCommand
	| ConfigCommand
	| PathsCommand
	| BackupCommand
	| AuthCommand
	| ControllerCommand;

export function createAgentVmParser(): Parser<'sync', AgentVmCommand> {
	return or(
		createInitCommand(),
		createManualSubcommands(),
		createMigrateSubcommands(),
		createResourcesSubcommands(),
		createBuildCommand(),
		createValidateCommand(),
		createDoctorCommand(),
		createCacheSubcommands(),
		createConfigSubcommands(),
		createPathsSubcommands(),
		createBackupSubcommands(),
		createAuthSubcommands(),
		createControllerSubcommands(),
	);
}

export const createAgentVmApp = createAgentVmParser;
