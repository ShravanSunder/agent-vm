import path from 'node:path';

import type { LoadedSystemConfig } from '../config/system-config.js';

export const runtimeConfigRoot = '/etc/agent-vm';

export function isRuntimeSystemConfigPath(systemConfig: LoadedSystemConfig): boolean {
	return (
		path.resolve(systemConfig.systemConfigPath) === path.join(runtimeConfigRoot, 'system.json')
	);
}
