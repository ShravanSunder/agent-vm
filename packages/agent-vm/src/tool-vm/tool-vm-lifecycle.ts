import path from 'node:path';

import { buildToolSessionLabel } from '@agent-vm/gateway-interface';
import {
	closePinnedRealFsRoot as closePinnedRealFsRootDefault,
	createManagedVm as createManagedVmFromCore,
	pinRealFsRoot as pinRealFsRootDefault,
	type ManagedVm,
	type PinnedRealFsRoot,
} from '@agent-vm/gondolin-adapter';

import { buildGondolinImage as buildGondolinImageDefault } from '../build/gondolin-image-builder.js';
import type { LoadedSystemConfig } from '../config/system-config.js';
import type { ToolVmProfile } from '../controller/leases/lease-manager.js';
import { validateResolvedToolWorkMountDir as validateResolvedToolWorkMountDirDefault } from '../controller/leases/lease-work-mount-paths.js';

export interface ToolVmLifecycleDependencies {
	readonly buildGondolinImage?: (options: {
		readonly buildConfigPath: string;
		readonly cacheDir: string;
		readonly fullReset?: boolean;
	}) => ReturnType<typeof buildGondolinImageDefault>;
	readonly createManagedVm?: typeof createManagedVmFromCore;
	readonly closePinnedRealFsRoot?: (root: PinnedRealFsRoot) => void;
	readonly pinRealFsRoot?: (hostPath: string) => PinnedRealFsRoot;
	readonly validateResolvedToolWorkMountDir?: typeof validateResolvedToolWorkMountDirDefault;
}

export async function createToolVm(
	options: {
		readonly cacheDir: string;
		readonly profile: ToolVmProfile;
		readonly systemConfig: LoadedSystemConfig;
		readonly tcpSlot: number;
		readonly hostWorkMountDir: string;
		readonly zoneId: string;
	},
	dependencies: ToolVmLifecycleDependencies = {},
): Promise<ManagedVm> {
	const buildGondolinImage = dependencies.buildGondolinImage ?? buildGondolinImageDefault;
	const createManagedVm = dependencies.createManagedVm ?? createManagedVmFromCore;
	const closePinnedRealFsRoot = dependencies.closePinnedRealFsRoot ?? closePinnedRealFsRootDefault;
	const pinRealFsRoot = dependencies.pinRealFsRoot ?? pinRealFsRootDefault;
	const validateResolvedToolWorkMountDir =
		dependencies.validateResolvedToolWorkMountDir ?? validateResolvedToolWorkMountDirDefault;
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
	// Fail bad lease paths before doing any expensive image work.
	await validateResolvedToolWorkMountDir({
		hostWorkMountDir: options.hostWorkMountDir,
		zone,
	});
	const toolImage = await buildGondolinImage({
		buildConfigPath: toolImageProfile.buildConfig,
		cacheDir: path.join(options.cacheDir, 'tool-vm-images', options.profile.imageProfile),
	});

	// Internal createToolVm callers bypass the /lease route; validate and pin
	// immediately before handing the RealFS root to the VM adapter.
	const hostWorkMountDirectory = await validateResolvedToolWorkMountDir({
		hostWorkMountDir: options.hostWorkMountDir,
		zone,
	});
	const pinnedWorkMountRoot = pinRealFsRoot(hostWorkMountDirectory);
	try {
		await validateResolvedToolWorkMountDir({
			hostWorkMountDir: pinnedWorkMountRoot.realPath,
			zone,
		});
	} catch (error) {
		closePinnedRealFsRoot(pinnedWorkMountRoot);
		throw error;
	}
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
				hostPath: hostWorkMountDirectory,
				kind: 'realfs',
				pinnedHostRoot: pinnedWorkMountRoot,
			},
		},
	});

	return toolVm;
}
