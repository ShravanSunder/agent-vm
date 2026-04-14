import fs from 'node:fs/promises';
import path from 'node:path';

import { buildToolSessionLabel } from '@shravansunder/agent-vm-gateway-interface';
import {
	createManagedVm as createManagedVmFromCore,
	type ManagedVm,
} from '@shravansunder/agent-vm-gondolin-core';

import { buildGondolinImage as buildGondolinImageDefault } from '../build/gondolin-image-builder.js';
import type { SystemConfig } from '../config/system-config.js';
import type { ToolProfile } from '../controller/leases/lease-manager.js';

export interface ToolVmLifecycleDependencies {
	readonly buildGondolinImage?: (options: {
		readonly buildConfigPath: string;
		readonly cacheDir: string;
		readonly fullReset?: boolean;
	}) => ReturnType<typeof buildGondolinImageDefault>;
	readonly createManagedVm?: typeof createManagedVmFromCore;
}

export function resolveToolVmWorkspaceDirectory(options: {
	readonly profile: ToolProfile;
	readonly tcpSlot: number;
	readonly zoneId: string;
}): string {
	return path.resolve(options.profile.workspaceRoot, `${options.zoneId}-${options.tcpSlot}`);
}

export async function cleanToolVmWorkspace(workspaceDirectory: string): Promise<void> {
	let entryNames: string[];
	try {
		entryNames = await fs.readdir(workspaceDirectory);
	} catch {
		return;
	}

	for (const entryName of entryNames) {
		// oxlint-disable-next-line eslint/no-await-in-loop -- cleanup must be deterministic per entry
		await fs.rm(path.join(workspaceDirectory, entryName), {
			force: true,
			recursive: true,
		});
	}
}

export async function createToolVm(
	options: {
		readonly cacheDir: string;
		readonly profile: ToolProfile;
		readonly systemConfig: SystemConfig;
		readonly tcpSlot: number;
		readonly workspaceDir: string;
		readonly zoneId: string;
	},
	dependencies: ToolVmLifecycleDependencies = {},
): Promise<ManagedVm> {
	const buildGondolinImage = dependencies.buildGondolinImage ?? buildGondolinImageDefault;
	const createManagedVm = dependencies.createManagedVm ?? createManagedVmFromCore;
	const toolImage = await buildGondolinImage({
		buildConfigPath: options.systemConfig.images.tool.buildConfig,
		cacheDir: path.join(options.cacheDir, 'images', 'tool'),
	});
	const hostWorkspaceDirectory = resolveToolVmWorkspaceDirectory({
		profile: options.profile,
		tcpSlot: options.tcpSlot,
		zoneId: options.zoneId,
	});

	await fs.mkdir(hostWorkspaceDirectory, { recursive: true });

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
			'/workspace': {
				hostPath: hostWorkspaceDirectory,
				kind: 'realfs',
			},
		},
	});

	return toolVm;
}
