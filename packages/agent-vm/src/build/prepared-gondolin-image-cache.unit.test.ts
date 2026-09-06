import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeImageArtifactFixture } from '../../../../scripts/test-fixtures/image-artifact-fixture.js';

import { computeFingerprintFromConfigPath } from './gondolin-image-builder.js';
import {
	configuredImageSelectionRecordPath,
	readPreparedManagedVmImage,
	writePreparedManagedVmImage,
} from './prepared-gondolin-image-cache.js';

const temporaryDirectories: string[] = [];

async function createFixture(): Promise<{
	readonly buildConfigPath: string;
	readonly deploymentGeneratedDir: string;
	readonly selectionRecordPath: string;
	readonly sharedImageCacheDir: string;
}> {
	const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-image-selection-'));
	temporaryDirectories.push(temporaryDirectory);
	const buildConfigPath = path.join(temporaryDirectory, 'build-config.jsonc');
	const deploymentGeneratedDir = path.join(temporaryDirectory, 'deployment-generated');
	const sharedImageCacheDir = path.join(temporaryDirectory, 'shared-images');
	await fs.writeFile(
		buildConfigPath,
		JSON.stringify({ arch: 'aarch64', distro: 'alpine' }),
		'utf8',
	);
	await fs.mkdir(sharedImageCacheDir, { recursive: true });
	return {
		buildConfigPath,
		deploymentGeneratedDir,
		selectionRecordPath: configuredImageSelectionRecordPath({
			deploymentGeneratedDir,
			family: 'gateway',
			profileName: 'hermes',
		}),
		sharedImageCacheDir,
	};
}

async function writeFakeImageAssets(imagePath: string): Promise<void> {
	await writeImageArtifactFixture(imagePath);
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map(async (directoryPath) => await fs.rm(directoryPath, { recursive: true, force: true })),
	);
});

describe('prepared Gondolin image selection', () => {
	it('returns invalid when a previously selected referenced input disappears', async () => {
		const fixture = await createFixture();
		const inputPath = path.join(path.dirname(fixture.buildConfigPath), 'input.txt');
		await fs.writeFile(inputPath, 'input');
		await fs.writeFile(fixture.buildConfigPath, JSON.stringify({ arch: 'aarch64', distro: 'alpine', postBuild: { copy: [{ src: './input.txt', dest: '/input' }] } }));
		const fingerprint = await computeFingerprintFromConfigPath(fixture.buildConfigPath);
		const imagePath = path.join(fixture.sharedImageCacheDir, fingerprint);
		await writeFakeImageAssets(imagePath);
		await writePreparedManagedVmImage({ ...fixture, imagePath, fingerprint });
		await fs.rm(inputPath);

		await expect(readPreparedManagedVmImage(fixture)).resolves.toBeUndefined();
	});
	it('rejects a self-consistent Hermes image for a standard consumer', async () => {
		const fixture = await createFixture();
		const managedGatewayBoot = { kind: 'managed-gateway-exact-two-role', frameworkBootEntry: 'hermes-framework-service' } as const;
		const fingerprint = await computeFingerprintFromConfigPath(fixture.buildConfigPath, { managedGatewayBoot });
		const imagePath = path.join(fixture.sharedImageCacheDir, fingerprint);
		await writeFakeImageAssets(imagePath);
		await writePreparedManagedVmImage({ ...fixture, fingerprint, imagePath, managedGatewayBoot });

		await expect(readPreparedManagedVmImage(fixture)).resolves.toBeUndefined();
		await expect(readPreparedManagedVmImage({ ...fixture, expectedManagedGatewayBoot: managedGatewayBoot })).resolves.toMatchObject({ fingerprint });
	});
	it('reads a matching selection and derives its image path from the shared root', async () => {
		const fixture = await createFixture();
		const fingerprintInput = { dockerRootfsIdentity: { layers: ['sha256:layer-a'] } };
		const fingerprint = await computeFingerprintFromConfigPath(fixture.buildConfigPath, {
			fingerprintInput,
		});
		const imagePath = path.join(fixture.sharedImageCacheDir, fingerprint);
		await writeFakeImageAssets(imagePath);

		await writePreparedManagedVmImage({
			buildConfigPath: fixture.buildConfigPath,
			fingerprint,
			fingerprintInput,
			imagePath,
			selectionRecordPath: fixture.selectionRecordPath,
			sharedImageCacheDir: fixture.sharedImageCacheDir,
		});

		await expect(readPreparedManagedVmImage(fixture)).resolves.toEqual({
			built: false,
			fingerprint,
			fingerprintInput,
			imagePath: await fs.realpath(imagePath),
		});
	});

	it('rejects writing a selection for an incomplete artifact', async () => {
		const fixture = await createFixture();
		const fingerprint = await computeFingerprintFromConfigPath(fixture.buildConfigPath);

		await expect(
			writePreparedManagedVmImage({
				buildConfigPath: fixture.buildConfigPath,
				fingerprint,
				imagePath: path.join(fixture.sharedImageCacheDir, fingerprint),
				selectionRecordPath: fixture.selectionRecordPath,
				sharedImageCacheDir: fixture.sharedImageCacheDir,
			}),
		).rejects.toThrow(/incomplete/u);
	});

	it('ignores malformed and legacy selection records', async () => {
		const fixture = await createFixture();
		await fs.mkdir(path.dirname(fixture.selectionRecordPath), { recursive: true });
		await fs.writeFile(fixture.selectionRecordPath, '{not-json', 'utf8');

		await expect(readPreparedManagedVmImage(fixture)).resolves.toBeUndefined();

		await fs.writeFile(
			fixture.selectionRecordPath,
			JSON.stringify({ fingerprint: '0123456789abcdef', schemaVersion: 2 }),
			'utf8',
		);
		await expect(readPreparedManagedVmImage(fixture)).resolves.toBeUndefined();
	});

	it('ignores a selection whose recipe identity no longer matches', async () => {
		const fixture = await createFixture();
		const fingerprint = await computeFingerprintFromConfigPath(fixture.buildConfigPath);
		const imagePath = path.join(fixture.sharedImageCacheDir, fingerprint);
		await writeFakeImageAssets(imagePath);
		await writePreparedManagedVmImage({
			buildConfigPath: fixture.buildConfigPath,
			fingerprint,
			imagePath,
			selectionRecordPath: fixture.selectionRecordPath,
			sharedImageCacheDir: fixture.sharedImageCacheDir,
		});
		const otherBuildConfigPath = path.join(path.dirname(fixture.buildConfigPath), 'other.jsonc');
		await fs.writeFile(
			otherBuildConfigPath,
			JSON.stringify({ arch: 'aarch64', distro: 'alpine' }),
			'utf8',
		);

		await expect(
			readPreparedManagedVmImage({ ...fixture, buildConfigPath: otherBuildConfigPath }),
		).resolves.toBeUndefined();
	});

	it('uses unique temporary paths for concurrent selection writers', async () => {
		const fixture = await createFixture();
		const firstInput = { dockerRootfsIdentity: { layers: ['sha256:first'] } };
		const secondInput = { dockerRootfsIdentity: { layers: ['sha256:second'] } };
		const firstFingerprint = await computeFingerprintFromConfigPath(fixture.buildConfigPath, {
			fingerprintInput: firstInput,
		});
		const secondFingerprint = await computeFingerprintFromConfigPath(fixture.buildConfigPath, {
			fingerprintInput: secondInput,
		});
		await Promise.all([
			writeFakeImageAssets(path.join(fixture.sharedImageCacheDir, firstFingerprint)),
			writeFakeImageAssets(path.join(fixture.sharedImageCacheDir, secondFingerprint)),
		]);

		await Promise.all([
			writePreparedManagedVmImage({
				buildConfigPath: fixture.buildConfigPath,
				fingerprint: firstFingerprint,
				fingerprintInput: firstInput,
				imagePath: path.join(fixture.sharedImageCacheDir, firstFingerprint),
				selectionRecordPath: fixture.selectionRecordPath,
				sharedImageCacheDir: fixture.sharedImageCacheDir,
			}),
			writePreparedManagedVmImage({
				buildConfigPath: fixture.buildConfigPath,
				fingerprint: secondFingerprint,
				fingerprintInput: secondInput,
				imagePath: path.join(fixture.sharedImageCacheDir, secondFingerprint),
				selectionRecordPath: fixture.selectionRecordPath,
				sharedImageCacheDir: fixture.sharedImageCacheDir,
			}),
		]);

		const preparedImage = await readPreparedManagedVmImage(fixture);
		expect([firstFingerprint, secondFingerprint]).toContain(preparedImage?.fingerprint);
	});
});
