import { realpath } from 'node:fs/promises';
import path from 'node:path';

import {
	buildToolSessionLabel,
	egressHostsForAudience,
	FORCE_IPV4_EGRESS_NODE_OPTIONS,
	splitResolvedSecretsByInjection,
} from '@agent-vm/gateway-interface';
import {
	closePinnedRealFsRoot as closePinnedRealFsRootDefault,
	createManagedVm as createManagedVmFromCore,
	pinRealFsRoot as pinRealFsRootDefault,
	type ManagedVm,
	type PinnedRealFsRoot,
} from '@agent-vm/gondolin-adapter';
import type { SecretResolver } from '@agent-vm/secret-management';

import { buildGondolinImage as buildGondolinImageDefault } from '../build/gondolin-image-builder.js';
import { readPreparedGondolinImage } from '../build/prepared-gondolin-image-cache.js';
import type { LoadedSystemConfig } from '../config/system-config.js';
import type { ToolVmProfile } from '../controller/leases/lease-manager.js';
import {
	OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
	validateResolvedToolWorkMountDir as validateResolvedToolWorkMountDirDefault,
} from '../controller/leases/lease-work-mount-paths.js';
import {
	OPENCLAW_ZONE_FILES_GUEST_ROOT,
	OPENCLAW_ZONE_GIT_GUEST_ROOT,
	resolveZoneGitPaths,
	type ZoneGitToolVmMount,
} from '../controller/zone-git/zone-git-paths.js';
import { resolveZoneSecrets } from '../gateway/credential-manager.js';

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

async function configureZoneGitToolVm(toolVm: ManagedVm): Promise<void> {
	const result = await toolVm.exec(
		`git config --global --add safe.directory ${OPENCLAW_ZONE_FILES_GUEST_ROOT}`,
	);
	if (result.exitCode !== 0) {
		throw new Error(
			`Failed to configure Tool VM Git safe.directory for ${OPENCLAW_ZONE_FILES_GUEST_ROOT}: ${result.stderr || result.stdout}`,
		);
	}
}

export async function createToolVm(
	options: {
		readonly cacheDir: string;
		readonly profile: ToolVmProfile;
		readonly systemConfig: LoadedSystemConfig;
		readonly tcpSlot: number;
		readonly hostWorkMountDir: string;
		readonly zoneGitMount?: ZoneGitToolVmMount;
		readonly zoneId: string;
		readonly secretResolver: SecretResolver;
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
	const resolvedSecrets = await resolveZoneSecrets({
		audience: 'tool-vm',
		injection: 'http-mediation',
		secretResolver: options.secretResolver,
		systemConfig: options.systemConfig,
		zoneId: options.zoneId,
	});
	const { mediatedSecrets } = splitResolvedSecretsByInjection(zone.secrets, resolvedSecrets, {
		audience: 'tool-vm',
		logPrefix: 'tool-vm-secrets',
	});
	const toolImageCacheDir = path.join(
		options.cacheDir,
		'tool-vm-images',
		options.profile.imageProfile,
	);
	const preparedToolImage = await readPreparedGondolinImage({
		buildConfigPath: toolImageProfile.buildConfig,
		cacheDir: toolImageCacheDir,
	});
	const toolImage =
		preparedToolImage ??
		(await buildGondolinImage({
			buildConfigPath: toolImageProfile.buildConfig,
			cacheDir: toolImageCacheDir,
		}));

	// Internal createToolVm callers bypass the /lease route; validate and pin
	// immediately before handing the RealFS root to the VM adapter.
	const hostWorkMountDirectory = await validateResolvedToolWorkMountDir({
		hostWorkMountDir: options.hostWorkMountDir,
		zone,
	});
	const pinnedRoots: PinnedRealFsRoot[] = [];
	const pinRoot = (hostPath: string): PinnedRealFsRoot => {
		const pinnedRoot = pinRealFsRoot(hostPath);
		pinnedRoots.push(pinnedRoot);
		return pinnedRoot;
	};
	let toolVm: ManagedVm | undefined;
	try {
		let vfsMounts: Parameters<typeof createManagedVm>[0]['vfsMounts'];
		if (options.zoneGitMount) {
			const hostZoneFilesDirectory = await validateResolvedToolWorkMountDir({
				hostWorkMountDir: options.zoneGitMount.hostZoneFilesDir,
				zone,
			});
			const hostZoneGitRoot = await realpath(options.zoneGitMount.hostZoneGitRoot);
			const expectedZoneGitRoot = await realpath(
				resolveZoneGitPaths({
					runtimeDir: options.systemConfig.runtimeDir,
					zoneId: options.zoneId,
				}).hostZoneGitRoot,
			);
			if (hostZoneGitRoot !== expectedZoneGitRoot) {
				throw new Error(
					`Zone Git root '${hostZoneGitRoot}' does not match expected runtime path '${expectedZoneGitRoot}' for zone '${options.zoneId}'.`,
				);
			}
			const pinnedZoneFilesRoot = pinRoot(hostZoneFilesDirectory);
			const pinnedZoneGitRoot = pinRoot(hostZoneGitRoot);
			await validateResolvedToolWorkMountDir({
				hostWorkMountDir: pinnedZoneFilesRoot.realPath,
				zone,
			});
			vfsMounts = {
				[OPENCLAW_ZONE_GIT_GUEST_ROOT]: {
					hostPath: hostZoneGitRoot,
					kind: 'realfs',
					pinnedHostRoot: pinnedZoneGitRoot,
				},
				[OPENCLAW_ZONE_FILES_GUEST_ROOT]: {
					hostPath: hostZoneFilesDirectory,
					kind: 'realfs',
					pinnedHostRoot: pinnedZoneFilesRoot,
				},
			};
		} else {
			const pinnedWorkMountRoot = pinRoot(hostWorkMountDirectory);
			await validateResolvedToolWorkMountDir({
				hostWorkMountDir: pinnedWorkMountRoot.realPath,
				zone,
			});
			vfsMounts = {
				[OPENCLAW_TOOL_VM_WORKSPACE_MOUNT]: {
					hostPath: hostWorkMountDirectory,
					kind: 'realfs',
					pinnedHostRoot: pinnedWorkMountRoot,
				},
			};
		}
		toolVm = await createManagedVm({
			allowedHosts: egressHostsForAudience(zone.egressHosts, 'tool-vm'),
			cpus: options.profile.cpus,
			env: {
				NODE_OPTIONS: FORCE_IPV4_EGRESS_NODE_OPTIONS,
			},
			imagePath: toolImage.imagePath,
			memory: options.profile.memory,
			rootfsMode: 'cow',
			...(options.profile.runtimeRootfsSize
				? { runtimeRootfsSize: options.profile.runtimeRootfsSize }
				: {}),
			sessionLabel: buildToolSessionLabel(
				options.systemConfig.host.projectNamespace,
				options.zoneId,
				options.tcpSlot,
			),
			secrets: mediatedSecrets,
			vfsMounts,
		});
		if (options.zoneGitMount) {
			await configureZoneGitToolVm(toolVm);
		}
		return toolVm;
	} catch (error) {
		if (toolVm) {
			try {
				await toolVm.close();
			} catch (closeError) {
				process.stderr.write(
					`Failed to close Tool VM after create failure: ${closeError instanceof Error ? closeError.message : String(closeError)}\n`,
				);
			}
		}
		for (const pinnedRoot of pinnedRoots) {
			closePinnedRealFsRoot(pinnedRoot);
		}
		throw error;
	}
}
