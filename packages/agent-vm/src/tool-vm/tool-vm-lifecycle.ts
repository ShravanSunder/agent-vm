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
import type { ToolProfile } from '../controller/leases/lease-manager.js';
import { validateResolvedToolWorkspaceDir as validateResolvedToolWorkspaceDirDefault } from '../controller/leases/lease-workspace-paths.js';

export interface ToolVmLifecycleDependencies {
	readonly buildGondolinImage?: (options: {
		readonly buildConfigPath: string;
		readonly systemCacheIdentifierPath: string;
		readonly cacheDir: string;
		readonly fullReset?: boolean;
	}) => ReturnType<typeof buildGondolinImageDefault>;
	readonly createManagedVm?: typeof createManagedVmFromCore;
	readonly closePinnedRealFsRoot?: (root: PinnedRealFsRoot) => void;
	readonly pinRealFsRoot?: (hostPath: string) => PinnedRealFsRoot;
	readonly validateResolvedToolWorkspaceDir?: typeof validateResolvedToolWorkspaceDirDefault;
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
	const closePinnedRealFsRoot = dependencies.closePinnedRealFsRoot ?? closePinnedRealFsRootDefault;
	const pinRealFsRoot = dependencies.pinRealFsRoot ?? pinRealFsRootDefault;
	const validateResolvedToolWorkspaceDir =
		dependencies.validateResolvedToolWorkspaceDir ?? validateResolvedToolWorkspaceDirDefault;
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
	await validateResolvedToolWorkspaceDir({
		workspaceDir: options.workspaceDir,
		zone,
	});
	const toolImage = await buildGondolinImage({
		buildConfigPath: toolImageProfile.buildConfig,
		systemCacheIdentifierPath: options.systemConfig.systemCacheIdentifierPath,
		cacheDir: path.join(options.cacheDir, 'tool-vm-images', options.profile.imageProfile),
	});

	// Internal createToolVm callers bypass the /lease route; validate and pin
	// immediately before handing the RealFS root to the VM adapter.
	const hostWorkspaceDirectory = await validateResolvedToolWorkspaceDir({
		workspaceDir: options.workspaceDir,
		zone,
	});
	const pinnedWorkspaceRoot = pinRealFsRoot(hostWorkspaceDirectory);
	try {
		await validateResolvedToolWorkspaceDir({
			workspaceDir: pinnedWorkspaceRoot.realPath,
			zone,
		});
	} catch (error) {
		closePinnedRealFsRoot(pinnedWorkspaceRoot);
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
				hostPath: hostWorkspaceDirectory,
				kind: 'realfs',
				pinnedHostRoot: pinnedWorkspaceRoot,
			},
		},
	});

	return toolVm;
}
