import path from 'node:path';

import type { LoadedSystemConfig } from '../config/system-config.js';

export const runtimeConfigRoot = '/etc/agent-vm';

export function isRuntimeSystemConfigPath(systemConfig: LoadedSystemConfig): boolean {
	return (
		path.resolve(systemConfig.systemConfigPath) === path.join(runtimeConfigRoot, 'system.json')
	);
}

export function isRuntimeConfigReference(configuredPath: string): boolean {
	const relativeRuntimePath = path.relative(runtimeConfigRoot, configuredPath);
	return (
		path.isAbsolute(configuredPath) &&
		(relativeRuntimePath === '' ||
			(!relativeRuntimePath.startsWith('..') && !path.isAbsolute(relativeRuntimePath)))
	);
}

export function hasRuntimeConfigReferences(systemConfig: LoadedSystemConfig): boolean {
	const gatewayProfiles = Object.values(systemConfig.imageProfiles.gateways);
	const toolVmProfiles = Object.values(systemConfig.imageProfiles.toolVms);
	return (
		[...gatewayProfiles, ...toolVmProfiles].some(
			(profile) =>
				isRuntimeConfigReference(profile.buildConfig) ||
				(profile.dockerfile ? isRuntimeConfigReference(profile.dockerfile) : false) ||
				(profile.source?.overlay ? isRuntimeConfigReference(profile.source.overlay) : false),
		) || systemConfig.zones.some((zone) => isRuntimeConfigReference(zone.gateway.config))
	);
}
