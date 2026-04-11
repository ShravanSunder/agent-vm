import fsSync from 'node:fs';
import path from 'node:path';

import { createManagedVm as createManagedVmFromCore, type ManagedVm } from 'gondolin-core';

import { buildGondolinImage as buildGondolinImageDefault } from '../build/gondolin-image-builder.js';
import type { ToolProfile } from '../controller/lease-manager.js';
import type { SystemConfig } from '../controller/system-config.js';

export interface ToolVmLifecycleDependencies {
	readonly buildGondolinImage?: (options: {
		readonly buildConfigPath: string;
		readonly cacheDir: string;
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

export function cleanToolVmWorkspace(workspaceDirectory: string): void {
	if (!fsSync.existsSync(workspaceDirectory)) {
		return;
	}

	for (const entryName of fsSync.readdirSync(workspaceDirectory)) {
		fsSync.rmSync(path.join(workspaceDirectory, entryName), {
			force: true,
			recursive: true,
		});
	}
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
	const buildGondolinImage = dependencies.buildGondolinImage ?? buildGondolinImageDefault;
	const createManagedVm = dependencies.createManagedVm ?? createManagedVmFromCore;
	const toolImage = await buildGondolinImage({
		buildConfigPath: options.systemConfig.images.tool.buildConfig,
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
