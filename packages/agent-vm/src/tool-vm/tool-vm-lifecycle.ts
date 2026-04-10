import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
	buildImage as buildImageFromCore,
	createManagedVm as createManagedVmFromCore,
	type BuildConfig,
	type ManagedVm,
} from 'gondolin-core';

import type { ToolProfile } from '../controller/lease-manager.js';
import type { SystemConfig } from '../controller/system-config.js';

export interface ToolVmLifecycleDependencies {
	readonly buildImage?: typeof buildImageFromCore;
	readonly createManagedVm?: typeof createManagedVmFromCore;
	readonly loadBuildConfig?: (buildConfigPath: string) => Promise<BuildConfig>;
}

export function resolveToolVmWorkspaceDirectory(options: {
	readonly profile: ToolProfile;
	readonly tcpSlot: number;
	readonly zoneId: string;
}): string {
	return path.resolve(
		options.profile.workspaceRoot,
		`${options.zoneId}-${options.tcpSlot}`,
	);
}

async function loadBuildConfigFromJson(
	buildConfigPath: string,
): Promise<BuildConfig> {
	return JSON.parse(await fs.readFile(buildConfigPath, 'utf8')) as BuildConfig;
}

export async function createToolVm(
	options: {
		readonly profile: ToolProfile;
		readonly systemConfig: SystemConfig;
		readonly tcpSlot: number;
		readonly workspaceDir: string;
		readonly zoneGatewayStateDirectory: string;
		readonly zoneId: string;
	},
	dependencies: ToolVmLifecycleDependencies = {},
): Promise<ManagedVm> {
	const loadBuildConfig =
		dependencies.loadBuildConfig ?? loadBuildConfigFromJson;
	const buildImage = dependencies.buildImage ?? buildImageFromCore;
	const createManagedVm =
		dependencies.createManagedVm ?? createManagedVmFromCore;
	const toolBuildConfig = await loadBuildConfig(
		options.systemConfig.images.tool.buildConfig,
	);
	const toolImage = await buildImage({
		buildConfig: toolBuildConfig,
		cacheDir: `${options.zoneGatewayStateDirectory}/images/tool`,
	});
	const hostWorkspaceDirectory = resolveToolVmWorkspaceDirectory({
		profile: options.profile,
		tcpSlot: options.tcpSlot,
		zoneId: options.zoneId,
	});

	fsSync.mkdirSync(hostWorkspaceDirectory, { recursive: true });

	const toolVm = await createManagedVm({
		allowedHosts: [],
		cpus: options.profile.cpus,
		imagePath: toolImage.imagePath,
		memory: options.profile.memory,
		rootfsMode: 'memory',
		sessionLabel: `${options.zoneId}-tool-${options.tcpSlot}`,
		secrets: {},
		vfsMounts: {
			'/workspace': {
				hostPath: hostWorkspaceDirectory,
				kind: 'realfs',
			},
		},
	});

	await toolVm.exec(
		'useradd -m -s /bin/bash sandbox 2>/dev/null; ' +
			'mkdir -p /workspace && chown sandbox:sandbox /workspace; ' +
			'ln -sf /proc/self/fd /dev/fd 2>/dev/null || true',
	);

	return toolVm;
}
