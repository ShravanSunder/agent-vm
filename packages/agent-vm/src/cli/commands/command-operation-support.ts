import { ZodError } from 'zod';

import type { LoadedSystemConfig } from '../../config/system-config.js';
import type { CliDependencies } from '../agent-vm-cli-support.js';
import { formatZodError } from '../format-zod-error.js';

export async function loadSystemConfigFromCliOption(
	configPath: string,
	dependencies: Pick<CliDependencies, 'loadSystemConfig'>,
): Promise<LoadedSystemConfig> {
	try {
		return await dependencies.loadSystemConfig(configPath);
	} catch (error) {
		if (error instanceof ZodError) {
			throw new Error(formatZodError(`Invalid ${configPath} configuration:`, error), {
				cause: error,
			});
		}
		if (error instanceof SyntaxError) {
			throw new Error(`Invalid JSON in ${configPath}: ${error.message}`, { cause: error });
		}
		throw error;
	}
}
