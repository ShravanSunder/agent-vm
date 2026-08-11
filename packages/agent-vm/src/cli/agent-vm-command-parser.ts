import { or, type InferValue } from '@optique/core';

import { authCommandParser } from './commands/auth-definition.js';
import { backupCommandParser } from './commands/backup-definition.js';
import { buildCommandParser } from './commands/build-definition.js';
import { cacheCommandParser } from './commands/cache-definition.js';
import { configCommandParser } from './commands/config-definition.js';
import { controllerCommandParser } from './commands/controller-definition.js';
import { doctorCommandParser } from './commands/doctor-definition.js';
import { initCommandParser } from './commands/init-definition.js';
import { manualCommandParser } from './commands/manual-definition.js';
import { migrateCommandParser } from './commands/migrate-definition.js';
import { pathsCommandParser } from './commands/paths-definition.js';
import { resourcesCommandParser } from './commands/resources-definition.js';
import { validateCommandParser } from './commands/validate-definition.js';

export const agentVmRootParser = or(
	initCommandParser,
	manualCommandParser,
	migrateCommandParser,
	resourcesCommandParser,
	buildCommandParser,
	validateCommandParser,
	doctorCommandParser,
	cacheCommandParser,
	configCommandParser,
	pathsCommandParser,
	backupCommandParser,
	authCommandParser,
	controllerCommandParser,
);

export type AgentVmCommand = InferValue<typeof agentVmRootParser>;
