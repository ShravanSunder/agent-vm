import path from 'node:path';

import type { SystemConfig } from '../../config/system-config.js';

export const OPENCLAW_ZONE_FILES_GUEST_ROOT = '/zone';
export const OPENCLAW_ZONE_GIT_GUEST_ROOT = '/agent-vm/zone-git';
export const OPENCLAW_ZONE_GIT_GUEST_DIR = `${OPENCLAW_ZONE_GIT_GUEST_ROOT}/zone-files.git`;

export interface ZoneGitPaths {
	readonly guestGitDir: typeof OPENCLAW_ZONE_GIT_GUEST_DIR;
	readonly guestZoneGitRoot: typeof OPENCLAW_ZONE_GIT_GUEST_ROOT;
	readonly hostGitDir: string;
	readonly hostZoneGitRoot: string;
}

export interface ZoneGitToolVmMount {
	readonly hostZoneFilesDir: string;
	readonly hostZoneGitRoot: string;
}

export function resolveZoneGitPaths(options: {
	readonly runtimeDir: string;
	readonly zoneId: string;
}): ZoneGitPaths {
	const hostZoneGitRoot = path.join(options.runtimeDir, 'zones', options.zoneId, 'zone-git');
	return {
		guestGitDir: OPENCLAW_ZONE_GIT_GUEST_DIR,
		guestZoneGitRoot: OPENCLAW_ZONE_GIT_GUEST_ROOT,
		hostGitDir: path.join(hostZoneGitRoot, 'zone-files.git'),
		hostZoneGitRoot,
	};
}

export function isOpenClawZoneGitConfigured(
	zone: SystemConfig['zones'][number],
): zone is SystemConfig['zones'][number] & {
	readonly gateway: Extract<
		SystemConfig['zones'][number]['gateway'],
		{ readonly type: 'openclaw' }
	> & {
		readonly zoneGit: NonNullable<
			Extract<SystemConfig['zones'][number]['gateway'], { readonly type: 'openclaw' }>['zoneGit']
		>;
	};
} {
	return zone.gateway.type === 'openclaw' && zone.gateway.zoneGit !== undefined;
}
