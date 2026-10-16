import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	inspectE2eImageCache,
	InspectionFailure,
	inspectionLimits,
	projectCacheProvenance,
	type CacheObservation,
	type InspectionIo,
	type InspectionPathInfo,
} from './inspect-e2e-image-cache.ts';

const cacheRoot = '/owned/cache';
const hermesRoot = path.join(cacheRoot, 'hermes');
const imageCache = path.join(hermesRoot, 'vm-images');
const preparedPath = path.join(hermesRoot, 'prepared-e2e-images.json');
const gatewayFingerprint = '0123456789abcdef';
const toolFingerprint = 'fedcba9876543210';
const abcSha256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const helloSha256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const aSha256 = 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb';
const emptySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const inputHash = '5'.repeat(64);
const provenanceEnvironment = {
	CACHE_INSPECTION_INPUT_HASH: inputHash,
	CACHE_INSPECTION_PREPARATION_INPUT_HASH: inputHash,
	CACHE_INSPECTION_CACHE_HIT: 'true',
	CACHE_INSPECTION_PRIMARY_KEY: 'agent-vm-e2e-images-v1-hermes-Linux-' + inputHash,
	CACHE_INSPECTION_PREPARATION_LOOKUP_HIT: 'true',
};
interface FixtureNode {
	readonly kind: InspectionPathInfo['kind'];
	readonly bytes?: Uint8Array;
	readonly sizeBytes?: number;
	readonly canonicalPath?: string;
	readonly failure?: InspectionFailure;
}
function jsonBytes(value: unknown): Uint8Array {
	return Buffer.from(JSON.stringify(value));
}
function imagePath(fingerprint = gatewayFingerprint): string {
	return path.join(imageCache, fingerprint);
}
function manifestPath(fingerprint = gatewayFingerprint): string {
	return path.join(imagePath(fingerprint), 'manifest.json');
}
function preparedEntry(
	family: 'gateway' | 'toolVm',
	name: string,
	fingerprint: string,
): Record<string, unknown> {
	return {
		family,
		name,
		fingerprint,
		imagePath: imagePath(fingerprint),
		cacheDirectory: imageCache,
	};
}
function imageManifest(): Record<string, unknown> {
	return {
		version: 1,
		buildId: 'fixture-build-id',
		buildTime: '2026-10-16T00:00:00Z',
		config: { arch: 'x86_64', distro: 'alpine', env: { TOKEN: 'fixture-private-token' } },
		runtimeDefaults: { rootfsMode: 'cow' },
		ociSource: { image: 'fixture-private-image-reference' },
		assets: { kernel: 'vmlinuz-virt', initramfs: 'initramfs.cpio.lz4', rootfs: 'rootfs.ext4' },
		checksums: { kernel: abcSha256, initramfs: helloSha256, rootfs: aSha256 },
	};
}
function fixture(): {
	readonly nodes: Map<string, FixtureNode>;
	readonly reads: string[];
	readonly io: InspectionIo;
	readonly observe: () => Promise<CacheObservation>;
	readonly writeJson: (filePath: string, value: unknown) => void;
} {
	const nodes = new Map<string, FixtureNode>();
	const reads: string[] = [];
	for (const directory of [
		cacheRoot,
		hermesRoot,
		imageCache,
		imagePath(),
		imagePath(toolFingerprint),
	]) {
		nodes.set(directory, { kind: 'directory' });
	}
	nodes.set(preparedPath, {
		kind: 'file',
		bytes: jsonBytes({
			schemaVersion: 2,
			entries: [
				preparedEntry('gateway', 'hermes', gatewayFingerprint),
				preparedEntry('toolVm', 'default', toolFingerprint),
			],
		}),
	});
	for (const fingerprint of [gatewayFingerprint, toolFingerprint]) {
		nodes.set(manifestPath(fingerprint), { kind: 'file', bytes: jsonBytes(imageManifest()) });
		for (const [fileName, text] of [
			['vmlinuz-virt', 'abc'],
			['initramfs.cpio.lz4', 'hello'],
			['rootfs.ext4', 'a'],
		]) {
			if (fileName === undefined || text === undefined) throw new Error('invalid-test-fixture');
			nodes.set(path.join(imagePath(fingerprint), fileName), {
				kind: 'file',
				bytes: Buffer.from(text),
			});
		}
	}
	function getNode(filePath: string): FixtureNode {
		const node = nodes.get(filePath);
		if (node === undefined) throw new InspectionFailure('missing');
		return node;
	}
	const io: InspectionIo = {
		async lstat(filePath) {
			const node = getNode(filePath);
			return {
				kind: node.kind,
				sizeBytes: node.sizeBytes ?? node.bytes?.byteLength ?? 0,
				identity: filePath,
			};
		},
		async realpath(filePath) {
			return getNode(filePath).canonicalPath ?? filePath;
		},
		async *readChunks({ filePath }) {
			const node = getNode(filePath);
			reads.push(filePath);
			if (node.failure !== undefined) throw node.failure;
			const bytes = node.bytes ?? new Uint8Array();
			yield bytes.subarray(0, 1);
			yield bytes.subarray(1);
		},
	};
	return {
		nodes,
		reads,
		io,
		observe: async () =>
			await inspectE2eImageCache({ cacheRoot, environment: provenanceEnvironment, io }),
		writeJson(filePath, value) {
			nodes.set(filePath, { kind: 'file', bytes: jsonBytes(value) });
		},
	};
}
function gatewayMetadata(record: CacheObservation): CacheObservation['images'][number]['metadata'] {
	const gateway = record.images.find((image) => image.family === 'gateway');
	if (gateway === undefined) throw new Error('missing-gateway-observation');
	return gateway.metadata;
}

describe('bounded prepared image cache observation', () => {
	it('hashes actual split chunks and compares their bytes with declared checksums', async () => {
		const data = fixture();
		const receipt = await data.observe();
		const gateway = gatewayMetadata(receipt);
		expect(gateway.status).toBe('measured');
		if (gateway.status !== 'measured') throw new Error('expected-measured');
		expect(gateway.fingerprint).toBe(gatewayFingerprint);
		expect(gateway.declaredArchitecture).toBe('x86_64');
		expect(gateway.declaredDistro).toBe('alpine');
		expect(gateway.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
		expect(gateway.configurationSha256).toMatch(/^[a-f0-9]{64}$/u);
		expect(gateway.assets).toEqual([
			{
				role: 'kernel',
				declaredSha256: abcSha256,
				bytes: { status: 'measured', sizeBytes: 3, sha256: abcSha256, checksumMatch: true },
			},
			{
				role: 'initramfs',
				declaredSha256: helloSha256,
				bytes: { status: 'measured', sizeBytes: 5, sha256: helloSha256, checksumMatch: true },
			},
			{
				role: 'rootfs',
				declaredSha256: aSha256,
				bytes: { status: 'measured', sizeBytes: 1, sha256: aSha256, checksumMatch: true },
			},
		]);
		expect(receipt.gatewayToolKernel).toBe('equal');
		expect(receipt.provenance.experiment).toBe('retained-cache');
	});
	it('reports checksum mismatch without treating declared hashes as measured bytes', async () => {
		const data = fixture();
		data.nodes.set(path.join(imagePath(), 'vmlinuz-virt'), {
			kind: 'file',
			bytes: Buffer.from('hello'),
		});
		const receipt = await data.observe();
		const gateway = gatewayMetadata(receipt);
		if (gateway.status !== 'measured') throw new Error('expected-measured');
		expect(gateway.assets[0]).toEqual({
			role: 'kernel',
			declaredSha256: abcSha256,
			bytes: { status: 'measured', sizeBytes: 5, sha256: helloSha256, checksumMatch: false },
		});
		expect(receipt.gatewayToolKernel).toBe('different');
	});
	it.each([
		['invalid-json', Buffer.from('{"schemaVersion":')],
		['wrong-schema', jsonBytes({ schemaVersion: 1, entries: [] })],
		['non-array', jsonBytes({ schemaVersion: 2, entries: {} })],
	])('projects malformed prepared manifest %s as a closed observation', async (_label, bytes) => {
		const data = fixture();
		data.nodes.set(preparedPath, { kind: 'file', bytes });
		const receipt = await data.observe();
		expect(receipt.preparedManifest).toEqual({ status: 'malformed' });
		expect(gatewayMetadata(receipt)).toEqual({ status: 'malformed' });
		expect(receipt.gatewayToolKernel).toBe('unavailable');
	});
	it('bounds the prepared entry list instead of selecting from an unbounded cache catalogue', async () => {
		const data = fixture();
		data.writeJson(preparedPath, {
			schemaVersion: 2,
			entries: Array.from({ length: 33 }, () => ({})),
		});
		expect((await data.observe()).preparedManifest).toEqual({ status: 'over-limit' });
	});
	it('refuses duplicate selected entries and never measures an arbitrary cache image', async () => {
		const data = fixture();
		data.writeJson(preparedPath, {
			schemaVersion: 2,
			entries: [
				preparedEntry('gateway', 'hermes', gatewayFingerprint),
				preparedEntry('gateway', 'hermes', toolFingerprint),
				preparedEntry('gateway', 'unselected-private-name', toolFingerprint),
			],
		});
		const receipt = await data.observe();
		expect(gatewayMetadata(receipt)).toEqual({ status: 'malformed' });
		expect(receipt.images[1]?.metadata).toEqual({ status: 'missing' });
		expect(data.reads).toEqual([preparedPath]);
	});
	it.each([
		{ imagePath: '/outside/private-rootfs' },
		{ imagePath: path.join(imagePath(), '..', '..', 'outside') },
		{ cacheDirectory: '/outside/private-cache' },
		{ imagePath: 'relative/private-image' },
	])('rejects selected entry path escape before opening any asset %#', async (override) => {
		const data = fixture();
		data.writeJson(preparedPath, {
			schemaVersion: 2,
			entries: [
				{
					...preparedEntry('gateway', 'hermes', gatewayFingerprint),
					...override,
				},
			],
		});
		expect(gatewayMetadata(await data.observe())).toEqual({ status: 'unsafe-path' });
		expect(data.reads).toEqual([preparedPath]);
	});
	it.each(['../unsafe', 'ABCDEF0123456789', '0'.repeat(17)])(
		'rejects noncanonical fingerprint %s',
		async (fingerprint) => {
			const data = fixture();
			data.writeJson(preparedPath, {
				schemaVersion: 2,
				entries: [preparedEntry('gateway', 'hermes', fingerprint)],
			});
			expect(gatewayMetadata(await data.observe())).toEqual({ status: 'malformed' });
			expect(data.reads).toEqual([preparedPath]);
		},
	);
	it.each([hermesRoot, imageCache, imagePath(), manifestPath()])(
		'rejects symlink in the selected chain %s',
		async (filePath) => {
			const data = fixture();
			data.nodes.set(filePath, { kind: 'symlink', canonicalPath: '/outside/private-target' });
			const receipt = await data.observe();
			expect(gatewayMetadata(receipt)).toEqual({ status: 'unsafe-path' });
			expect(data.reads).not.toContain(filePath);
		},
	);
	it('rejects canonical containment mismatch even when lstat looks like a directory', async () => {
		const data = fixture();
		data.nodes.set(imagePath(), { kind: 'directory', canonicalPath: '/outside/private-image' });
		expect(gatewayMetadata(await data.observe())).toEqual({ status: 'unsafe-path' });
		expect(data.reads).not.toContain(manifestPath());
	});
	it.each([
		{ version: 2 },
		{ config: null },
		{
			assets: { kernel: '../private-file', initramfs: 'initramfs.cpio.lz4', rootfs: 'rootfs.ext4' },
		},
		{
			assets: {
				kernel: 'vmlinuz-virt',
				initramfs: 'initramfs.cpio.lz4',
				rootfs: 'rootfs.ext4',
				privateRole: 'private-file',
			},
		},
		{ checksums: { kernel: 'not-a-digest', initramfs: helloSha256, rootfs: aSha256 } },
		{ checksums: { kernel: abcSha256, initramfs: helloSha256 } },
	])('closes malformed image manifest before asset reads %#', async (override) => {
		const data = fixture();
		data.writeJson(manifestPath(), { ...imageManifest(), ...override });
		expect(gatewayMetadata(await data.observe())).toEqual({ status: 'malformed' });
		expect(data.reads).not.toContain(path.join(imagePath(), 'vmlinuz-virt'));
	});
	it.each([
		['prepared', preparedPath, inspectionLimits.preparedManifestBytes],
		['image', manifestPath(), inspectionLimits.imageManifestBytes],
	])('rejects oversized %s manifest before reading it', async (_label, filePath, maxBytes) => {
		const data = fixture();
		data.nodes.set(filePath, { kind: 'file', sizeBytes: maxBytes + 1 });
		const receipt = await data.observe();
		expect(filePath === preparedPath ? receipt.preparedManifest : gatewayMetadata(receipt)).toEqual(
			{ status: 'over-limit' },
		);
		expect(data.reads).not.toContain(filePath);
	});
	it.each([
		['kernel', 'vmlinuz-virt'],
		['initramfs', 'initramfs.cpio.lz4'],
		['rootfs', 'rootfs.ext4'],
		['krunKernel', 'krun-kernel'],
		['krunInitrd', 'krun-empty-initrd'],
	] as const)('rejects oversized %s asset before reading it', async (role, fileName) => {
		const data = fixture();
		if (role === 'krunKernel' || role === 'krunInitrd')
			data.writeJson(manifestPath(), {
				...imageManifest(),
				assets: {
					kernel: 'vmlinuz-virt',
					initramfs: 'initramfs.cpio.lz4',
					rootfs: 'rootfs.ext4',
					[role]: fileName,
				},
				checksums: {
					kernel: abcSha256,
					initramfs: helloSha256,
					rootfs: aSha256,
					[role]: emptySha256,
				},
			});
		const filePath = path.join(imagePath(), fileName);
		data.nodes.set(filePath, { kind: 'file', sizeBytes: inspectionLimits[role] + 1 });
		const gateway = gatewayMetadata(await data.observe());
		if (gateway.status !== 'measured') throw new Error('expected-measured-metadata');
		expect(gateway.assets.find((asset) => asset.role === role)?.bytes).toEqual({
			status: 'over-limit',
		});
		expect(data.reads).not.toContain(filePath);
	});
	it('permits the stock empty krun initrd but rejects empty required assets', async () => {
		const data = fixture();
		data.writeJson(manifestPath(), {
			...imageManifest(),
			assets: {
				kernel: 'vmlinuz-virt',
				initramfs: 'initramfs.cpio.lz4',
				rootfs: 'rootfs.ext4',
				krunInitrd: 'krun-empty-initrd',
			},
			checksums: {
				kernel: abcSha256,
				initramfs: helloSha256,
				rootfs: aSha256,
				krunInitrd: emptySha256,
			},
		});
		data.nodes.set(path.join(imagePath(), 'krun-empty-initrd'), {
			kind: 'file',
			bytes: new Uint8Array(),
		});
		data.nodes.set(path.join(imagePath(), 'rootfs.ext4'), {
			kind: 'file',
			bytes: new Uint8Array(),
		});
		const gateway = gatewayMetadata(await data.observe());
		if (gateway.status !== 'measured') throw new Error('expected-measured-metadata');
		expect(gateway.assets.find((asset) => asset.role === 'krunInitrd')?.bytes).toEqual({
			status: 'measured',
			sizeBytes: 0,
			sha256: emptySha256,
			checksumMatch: true,
		});
		expect(gateway.assets.find((asset) => asset.role === 'rootfs')?.bytes).toEqual({
			status: 'malformed',
		});
	});
	it.each(['symlink', 'directory', 'other'] as const)('does not open a %s asset', async (kind) => {
		const data = fixture();
		const filePath = path.join(imagePath(), 'vmlinuz-virt');
		data.nodes.set(filePath, { kind });
		const receipt = await data.observe();
		const gateway = gatewayMetadata(receipt);
		if (gateway.status !== 'measured') throw new Error('expected-measured-metadata');
		expect(gateway.assets[0]?.bytes).toEqual({ status: 'unsafe-path' });
		expect(data.reads).not.toContain(filePath);
		expect(receipt.gatewayToolKernel).toBe('unavailable');
	});
	it('reports missing and read-failed assets without substituting manifest digests', async () => {
		const data = fixture();
		data.nodes.delete(path.join(imagePath(), 'vmlinuz-virt'));
		data.nodes.set(path.join(imagePath(), 'initramfs.cpio.lz4'), {
			kind: 'file',
			sizeBytes: 5,
			failure: new InspectionFailure('read-failed'),
		});
		const gateway = gatewayMetadata(await data.observe());
		if (gateway.status !== 'measured') throw new Error('expected-measured-metadata');
		expect(gateway.assets[0]?.bytes).toEqual({ status: 'missing' });
		expect(gateway.assets[1]?.bytes).toEqual({ status: 'read-failed' });
	});
	it('does not label a short read as a full measured hash', async () => {
		const data = fixture();
		data.nodes.set(path.join(imagePath(), 'vmlinuz-virt'), {
			kind: 'file',
			bytes: Buffer.from('a'),
			sizeBytes: 3,
		});
		const gateway = gatewayMetadata(await data.observe());
		if (gateway.status !== 'measured') throw new Error('expected-measured-metadata');
		expect(gateway.assets[0]?.bytes).toEqual({ status: 'changed-during-read' });
	});
	it('stops a growing stream at the cap without returning a prefix hash', async () => {
		const data = fixture();
		data.nodes.set(preparedPath, {
			kind: 'file',
			sizeBytes: 1,
			bytes: new Uint8Array(inspectionLimits.preparedManifestBytes + 1),
		});
		expect((await data.observe()).preparedManifest).toEqual({ status: 'over-limit' });
	});
	it('stops a growing asset stream without emitting a prefix digest', async () => {
		const data = fixture();
		data.writeJson(manifestPath(), {
			...imageManifest(),
			assets: {
				kernel: 'vmlinuz-virt',
				initramfs: 'initramfs.cpio.lz4',
				rootfs: 'rootfs.ext4',
				krunInitrd: 'krun-empty-initrd',
			},
			checksums: {
				kernel: abcSha256,
				initramfs: helloSha256,
				rootfs: aSha256,
				krunInitrd: emptySha256,
			},
		});
		data.nodes.set(path.join(imagePath(), 'krun-empty-initrd'), {
			kind: 'file',
			sizeBytes: 1,
			bytes: new Uint8Array(inspectionLimits.krunInitrd + 1),
		});
		const gateway = gatewayMetadata(await data.observe());
		if (gateway.status !== 'measured') throw new Error('expected-measured-metadata');
		expect(gateway.assets.find((asset) => asset.role === 'krunInitrd')?.bytes).toEqual({
			status: 'over-limit',
		});
	});
	it('canonicalizes metadata order but fingerprints runtime configuration changes', async () => {
		const data = fixture();
		const initial = gatewayMetadata(await data.observe());
		const original = imageManifest();
		data.writeJson(manifestPath(), {
			...original,
			config: { env: { TOKEN: 'fixture-private-token' }, distro: 'alpine', arch: 'x86_64' },
		});
		const reordered = gatewayMetadata(await data.observe());
		data.writeJson(manifestPath(), { ...original, runtimeDefaults: { rootfsMode: 'memory' } });
		const changed = gatewayMetadata(await data.observe());
		if (
			initial.status !== 'measured' ||
			reordered.status !== 'measured' ||
			changed.status !== 'measured'
		)
			throw new Error('expected-measured');
		expect(reordered.configurationSha256).toBe(initial.configurationSha256);
		expect(reordered.manifestSha256).not.toBe(initial.manifestSha256);
		expect(changed.configurationSha256).not.toBe(initial.configurationSha256);
	});
	it('outputs fixed categories and hashes without raw metadata, paths, environment, or references', async () => {
		const data = fixture();
		const receipt = await inspectE2eImageCache({
			cacheRoot,
			io: data.io,
			environment: { ...provenanceEnvironment, CACHE_INSPECTION_PRIMARY_KEY: 'fixture-secret-ref' },
		});
		const text = JSON.stringify(receipt);
		for (const secret of [
			cacheRoot,
			'fixture-private-token',
			'fixture-private-image-reference',
			'fixture-build-id',
			'fixture-secret-ref',
			'vmlinuz-virt',
		]) {
			expect(text).not.toContain(secret);
		}
		expect(text.length).toBeLessThan(16 * 1024);
		expect(receipt.provenance.consumerPrimaryKey).toBeNull();
		expect(receipt.provenance.experiment).toBe('unconfirmed');
	});
	it('uses unknown architecture/distro categories without echoing input text', async () => {
		const data = fixture();
		data.writeJson(manifestPath(), {
			...imageManifest(),
			config: { arch: 'private-arch', distro: 'private-distro' },
		});
		const gateway = gatewayMetadata(await data.observe());
		expect(gateway).toMatchObject({
			status: 'measured',
			declaredArchitecture: 'unknown',
			declaredDistro: 'unknown',
		});
		expect(JSON.stringify(gateway)).not.toContain('private-');
	});
	it('does not turn an unexpected program error into a successful observation', async () => {
		const data = fixture();
		const io: InspectionIo = {
			...data.io,
			async lstat() {
				throw new Error('unexpected-program-failure');
			},
		};
		await expect(inspectE2eImageCache({ cacheRoot, environment: {}, io })).rejects.toThrow(
			'unexpected-program-failure',
		);
	});
});

describe('safe cache provenance', () => {
	it('distinguishes retained cache, rebuilt cache and unconfirmed identity', () => {
		expect(projectCacheProvenance(provenanceEnvironment).experiment).toBe('retained-cache');
		expect(
			projectCacheProvenance({
				...provenanceEnvironment,
				CACHE_INSPECTION_PREPARATION_LOOKUP_HIT: '',
			}).experiment,
		).toBe('rebuilt-cache');
		for (const override of [
			{ CACHE_INSPECTION_INPUT_HASH: 'bad-private-hash' },
			{ CACHE_INSPECTION_PREPARATION_INPUT_HASH: 'a'.repeat(64) },
			{ CACHE_INSPECTION_PRIMARY_KEY: 'agent-vm-e2e-images-v1-hermes-Linux-' + 'a'.repeat(64) },
			{ CACHE_INSPECTION_CACHE_HIT: 'false' },
			{ CACHE_INSPECTION_PREPARATION_LOOKUP_HIT: undefined },
		])
			expect(projectCacheProvenance({ ...provenanceEnvironment, ...override }).experiment).toBe(
				'unconfirmed',
			);
		expect(projectCacheProvenance({})).toEqual({
			inputHash: null,
			preparationInputHash: null,
			consumerPrimaryKey: null,
			consumerCacheHit: 'unknown',
			preparationLookup: 'unknown',
			experiment: 'unconfirmed',
		});
	});
});
