import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadJsonConfigFile } from '../config/json-config-file.js';

export interface MigrateImagesCommandResult {
	readonly migratedProfiles: readonly string[];
	readonly skippedProfiles: readonly string[];
}

interface MutableImageProfile {
	type?: unknown;
	buildConfig?: unknown;
	dockerfile?: unknown;
	source?: unknown;
}

interface MutableSystemConfig {
	imageProfiles?: {
		gateways?: Record<string, MutableImageProfile>;
		toolVms?: Record<string, MutableImageProfile>;
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMutableSystemConfig(value: unknown): MutableSystemConfig {
	if (!isRecord(value)) {
		throw new Error('system config must be an object.');
	}
	const imageProfiles = value.imageProfiles;
	if (imageProfiles !== undefined && !isRecord(imageProfiles)) {
		throw new Error('system config imageProfiles must be an object.');
	}
	return value as MutableSystemConfig;
}

function resolveManagedGatewayBase(
	profile: MutableImageProfile,
): 'openclaw-gateway' | 'worker-gateway' {
	return profile.type === 'openclaw' ? 'openclaw-gateway' : 'worker-gateway';
}

function resolveOverlayPathFromDockerfile(dockerfilePath: string): string {
	return path.posix.join(path.posix.dirname(dockerfilePath), 'overlay.jsonc');
}

function resolveOverlayFilePath(configPath: string, overlayPath: string): string {
	if (path.isAbsolute(overlayPath)) {
		return overlayPath;
	}
	return path.resolve(path.dirname(configPath), overlayPath);
}

async function writeOverlayIfMissing(overlayFilePath: string): Promise<void> {
	try {
		await readFile(overlayFilePath, 'utf8');
	} catch (error) {
		if (
			typeof error !== 'object' ||
			error === null ||
			!('code' in error) ||
			error.code !== 'ENOENT'
		) {
			throw error;
		}
		await mkdir(path.dirname(overlayFilePath), { recursive: true });
		await writeFile(
			overlayFilePath,
			[
				'{',
				'  // Human-authored managed image overlay. Comments are allowed here.',
				'  "schemaVersion": 1,',
				'  "extraAptPackages": []',
				'}',
				'',
			].join('\n'),
			'utf8',
		);
	}
}

async function migrateImageProfile(props: {
	readonly configPath: string;
	readonly family: 'gateway' | 'toolVm';
	readonly profile: MutableImageProfile;
	readonly profileName: string;
}): Promise<'migrated' | 'skipped'> {
	if (props.profile.source !== undefined || typeof props.profile.dockerfile !== 'string') {
		return 'skipped';
	}
	const overlayPath = resolveOverlayPathFromDockerfile(props.profile.dockerfile);
	props.profile.source = {
		kind: 'managedBase',
		base: props.family === 'gateway' ? resolveManagedGatewayBase(props.profile) : 'tool-vm',
		overlay: overlayPath,
	};
	delete props.profile.dockerfile;
	await writeOverlayIfMissing(resolveOverlayFilePath(props.configPath, overlayPath));
	return 'migrated';
}

export async function runMigrateImagesCommand(options: {
	readonly systemConfigPath: string;
}): Promise<MigrateImagesCommandResult> {
	const rawConfig = parseMutableSystemConfig(await loadJsonConfigFile(options.systemConfigPath));
	const migratedProfiles: string[] = [];
	const skippedProfiles: string[] = [];
	for (const [profileName, profile] of Object.entries(rawConfig.imageProfiles?.gateways ?? {})) {
		// oxlint-disable-next-line no-await-in-loop -- rewrites stay deterministic and low-volume
		const status = await migrateImageProfile({
			configPath: options.systemConfigPath,
			family: 'gateway',
			profile,
			profileName,
		});
		(status === 'migrated' ? migratedProfiles : skippedProfiles).push(`gateway/${profileName}`);
	}
	for (const [profileName, profile] of Object.entries(rawConfig.imageProfiles?.toolVms ?? {})) {
		// oxlint-disable-next-line no-await-in-loop -- rewrites stay deterministic and low-volume
		const status = await migrateImageProfile({
			configPath: options.systemConfigPath,
			family: 'toolVm',
			profile,
			profileName,
		});
		(status === 'migrated' ? migratedProfiles : skippedProfiles).push(`toolVm/${profileName}`);
	}
	await writeFile(options.systemConfigPath, `${JSON.stringify(rawConfig, null, '\t')}\n`, 'utf8');
	return { migratedProfiles, skippedProfiles };
}
