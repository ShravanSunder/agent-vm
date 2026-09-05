import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { writeImageArtifactFixture } from '../../../../scripts/test-fixtures/image-artifact-fixture.js';
import { computeFingerprintFromConfigPath } from '../build/gondolin-image-builder.js';
import {
	configuredImageSelectionRecordPath,
	writePreparedManagedVmImage,
} from '../build/prepared-gondolin-image-cache.js';
import {
	deploymentGeneratedDirForStorageRoot,
	sharedImageCacheDirForSystemConfig,
	type LoadedSystemConfig,
} from '../config/system-config.js';

export const invalidImageSelectionKinds = [
	'missing',
	'malformed',
	'mismatched',
	'escaped',
	'incomplete',
] as const;

export async function createInvalidImageSelectionFixture(options: {
	readonly systemConfig: LoadedSystemConfig;
	readonly family: 'gateway' | 'toolVm';
	readonly profileName: string;
	readonly invalidKind: (typeof invalidImageSelectionKinds)[number];
}): Promise<LoadedSystemConfig> {
	const buildConfigPath = path.join(
		options.systemConfig.storageRootDir,
		'selection-fixture-recipe.json',
	);
	await mkdir(path.dirname(buildConfigPath), { recursive: true });
	await writeFile(buildConfigPath, JSON.stringify({ arch: 'aarch64', distro: 'alpine' }));
	const familyKey = options.family === 'gateway' ? 'gateways' : 'toolVms';
	const originalProfile = options.systemConfig.imageProfiles[familyKey][options.profileName];
	if (originalProfile === undefined) throw new Error('Expected configured image profile.');
	const systemConfig = {
		...options.systemConfig,
		cacheDir: path.join(options.systemConfig.storageRootDir, 'fixture-cache'),
		imageProfiles: {
			...options.systemConfig.imageProfiles,
			[familyKey]: {
				...options.systemConfig.imageProfiles[familyKey],
				[options.profileName]: { ...originalProfile, buildConfig: buildConfigPath },
			},
		},
	};
	const sharedImageCacheDir = sharedImageCacheDirForSystemConfig(systemConfig);
	const fingerprint = await computeFingerprintFromConfigPath(buildConfigPath);
	const imagePath = path.join(sharedImageCacheDir, fingerprint);
	const selectionRecordPath = configuredImageSelectionRecordPath({
		deploymentGeneratedDir: deploymentGeneratedDirForStorageRoot(systemConfig.storageRootDir),
		family: options.family,
		profileName: options.profileName,
	});
	await writeImageArtifactFixture(imagePath);
	await writePreparedManagedVmImage({
		buildConfigPath,
		fingerprint,
		imagePath,
		selectionRecordPath,
		sharedImageCacheDir,
	});
	if (options.invalidKind === 'missing') await rm(selectionRecordPath);
	if (options.invalidKind === 'malformed') await writeFile(selectionRecordPath, '{');
	if (options.invalidKind === 'mismatched' || options.invalidKind === 'escaped') {
		const record: Record<string, unknown> = JSON.parse(await readFile(selectionRecordPath, 'utf8'));
		record.fingerprint = options.invalidKind === 'escaped' ? '../../outside' : '0000000000000000';
		await writeFile(selectionRecordPath, JSON.stringify(record));
	}
	if (options.invalidKind === 'incomplete') await rm(path.join(imagePath, 'rootfs.ext4'));
	return systemConfig;
}
