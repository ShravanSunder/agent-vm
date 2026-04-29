import path from 'node:path';

import { buildToolSessionLabel } from '@agent-vm/gateway-interface';
import {
	createManagedVm as createManagedVmFromCore,
	type ManagedVm,
} from '@agent-vm/gondolin-adapter';

import { buildGondolinImage as buildGondolinImageDefault } from '../build/gondolin-image-builder.js';
import type { LoadedSystemConfig } from '../config/system-config.js';
import type { ToolProfile } from '../controller/leases/lease-manager.js';
import { resolveLeaseWorkspaceDir } from '../controller/leases/lease-workspace-paths.js';

export interface ToolVmLifecycleDependencies {
	readonly buildGondolinImage?: (options: {
		readonly buildConfigPath: string;
		readonly systemCacheIdentifierPath: string;
		readonly cacheDir: string;
		readonly fullReset?: boolean;
	}) => ReturnType<typeof buildGondolinImageDefault>;
	readonly createManagedVm?: typeof createManagedVmFromCore;
}

export async function createToolVm(
	options: {
		readonly cacheDir: string;
		readonly profile: ToolProfile;
		readonly systemConfig: LoadedSystemConfig;
		readonly tcpSlot: number;
		readonly workspaceDir: string;
		readonly zoneId: string;
	},
	dependencies: ToolVmLifecycleDependencies = {},
): Promise<ManagedVm> {
	const buildGondolinImage = dependencies.buildGondolinImage ?? buildGondolinImageDefault;
	const createManagedVm = dependencies.createManagedVm ?? createManagedVmFromCore;
	const zone = options.systemConfig.zones.find(
		(configuredZone) => configuredZone.id === options.zoneId,
	);
	if (!zone) {
		throw new Error(`Zone '${options.zoneId}' is not configured.`);
	}
	const toolImageProfile = options.systemConfig.imageProfiles.toolVms[options.profile.imageProfile];
	if (!toolImageProfile) {
		throw new Error(`Tool VM image profile '${options.profile.imageProfile}' is not configured.`);
	}
	const hostWorkspaceDirectory = await resolveLeaseWorkspaceDir({
		workspaceDir: options.workspaceDir,
		zone,
	});
	const toolImage = await buildGondolinImage({
		buildConfigPath: toolImageProfile.buildConfig,
		systemCacheIdentifierPath: options.systemConfig.systemCacheIdentifierPath,
		cacheDir: path.join(options.cacheDir, 'tool-vm-images', options.profile.imageProfile),
	});

	const toolVm = await createManagedVm({
		allowedHosts: [],
		cpus: options.profile.cpus,
		imagePath: toolImage.imagePath,
		memory: options.profile.memory,
		rootfsMode: 'memory',
		sessionLabel: buildToolSessionLabel(
			options.systemConfig.host.projectNamespace,
			options.zoneId,
			options.tcpSlot,
		),
		secrets: {},
		vfsMounts: {
			'/work': {
				hostPath: hostWorkspaceDirectory,
				kind: 'realfs',
			},
		},
	});

	return toolVm;
}
