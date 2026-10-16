/// <reference types="node" />
/// <reference lib="es2024" />
import { createHash } from 'node:crypto';
import path from 'node:path';

import {
	inspectionLimits,
	type CacheObservation,
	type InspectionIo,
} from './inspect-e2e-image-cache.ts';

export type MeasuredImageMetadata = Extract<
	CacheObservation['images'][number]['metadata'],
	{ readonly status: 'measured' }
>;
export interface BootImageInput {
	readonly family: 'toolVm' | 'gateway';
	readonly name: 'default' | 'hermes';
	readonly recipeFingerprint: string;
	readonly imagePath: string;
	readonly selectedKernel: string;
	readonly selectedInitrd: string;
	readonly metadata: MeasuredImageMetadata;
}
export type BootInputs =
	| { readonly status: 'available'; readonly images: readonly [BootImageInput, BootImageInput] }
	| {
			readonly status: 'unavailable';
			readonly reason:
				| 'different-experiment'
				| 'invalid-assets'
				| 'invalid-selection'
				| 'read-failed'
				| 'custom-start-timeout';
	  };
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasCompleteMeasuredAssets(metadata: MeasuredImageMetadata): boolean {
	const roles = metadata.assets.map((asset) => asset.role);
	return (
		metadata.assets.length >= 3 &&
		metadata.assets.length <= 5 &&
		new Set(roles).size === roles.length &&
		['kernel', 'initramfs', 'rootfs'].every((role) =>
			roles.some((candidate) => candidate === role),
		) &&
		metadata.assets.every((asset) => asset.bytes.status === 'measured' && asset.bytes.checksumMatch)
	);
}
async function readBoundManifest(props: {
	readonly cacheRoot: string;
	readonly io: InspectionIo;
	readonly expectedSha256: string;
}): Promise<unknown> {
	const cacheRoot = path.resolve(props.cacheRoot);
	const hermesRoot = path.join(cacheRoot, 'hermes');
	const filePath = path.join(hermesRoot, 'prepared-e2e-images.json');
	if (
		(await props.io.lstat(cacheRoot)).kind !== 'directory' ||
		(await props.io.lstat(hermesRoot)).kind !== 'directory'
	)
		throw new Error('unsafe-input-root');
	const expectedCanonical = path.join(
		await props.io.realpath(cacheRoot),
		'hermes',
		'prepared-e2e-images.json',
	);
	const info = await props.io.lstat(filePath);
	if (
		info.kind !== 'file' ||
		info.sizeBytes <= 0 ||
		info.sizeBytes > inspectionLimits.preparedManifestBytes ||
		(await props.io.realpath(filePath)) !== expectedCanonical
	)
		throw new Error('unsafe-input-manifest');
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of props.io.readChunks({
		filePath,
		identity: info.identity,
		maxBytes: inspectionLimits.preparedManifestBytes,
	})) {
		size += chunk.byteLength;
		if (size > inspectionLimits.preparedManifestBytes) throw new Error('input-manifest-over-limit');
		chunks.push(chunk);
	}
	const bytes = Buffer.concat(chunks);
	if (
		size !== info.sizeBytes ||
		createHash('sha256').update(bytes).digest('hex') !== props.expectedSha256
	)
		throw new Error('input-manifest-changed');
	return JSON.parse(bytes.toString('utf8')) as unknown;
}
export async function selectBootProbeInputs(props: {
	readonly observation: CacheObservation;
	readonly cacheRoot: string;
	readonly io: InspectionIo;
	readonly environment: Readonly<Record<string, string | undefined>>;
}): Promise<BootInputs> {
	if (props.environment.GONDOLIN_START_TIMEOUT_MS !== undefined)
		return { status: 'unavailable', reason: 'custom-start-timeout' };
	if (props.observation.provenance.experiment !== 'retained-cache')
		return { status: 'unavailable', reason: 'different-experiment' };
	if (
		props.observation.preparedManifest.status !== 'measured' ||
		props.observation.images.length !== 2
	)
		return { status: 'unavailable', reason: 'invalid-assets' };
	if (
		props.observation.images.some(
			(image) => image.metadata.status !== 'measured' || !hasCompleteMeasuredAssets(image.metadata),
		)
	)
		return { status: 'unavailable', reason: 'invalid-assets' };
	try {
		const raw = await readBoundManifest({
			cacheRoot: props.cacheRoot,
			io: props.io,
			expectedSha256: props.observation.preparedManifest.sha256,
		});
		if (
			!isRecord(raw) ||
			raw.schemaVersion !== 2 ||
			!Array.isArray(raw.entries) ||
			raw.entries.length > inspectionLimits.manifestEntries
		)
			return { status: 'unavailable', reason: 'invalid-selection' };
		const selected: BootImageInput[] = [];
		// Tool is a same-cache counterpart, not a known-good control.
		for (const selection of [
			{ family: 'toolVm', name: 'default' },
			{ family: 'gateway', name: 'hermes' },
		] as const) {
			const observed = props.observation.images.filter(
				(image) => image.family === selection.family && image.name === selection.name,
			);
			const image = observed[0];
			if (observed.length !== 1 || image?.metadata.status !== 'measured')
				return { status: 'unavailable', reason: 'invalid-selection' };
			const metadata = image.metadata;
			const entries = raw.entries.filter(
				(entry: unknown) =>
					isRecord(entry) &&
					entry.family === selection.family &&
					entry.name === selection.name &&
					entry.fingerprint === metadata.fingerprint,
			);
			const entry: unknown = entries[0];
			if (
				entries.length !== 1 ||
				!isRecord(entry) ||
				typeof entry.recipeFingerprint !== 'string' ||
				!/^[a-f0-9]{64}$/u.test(entry.recipeFingerprint)
			)
				return { status: 'unavailable', reason: 'invalid-selection' };
			const imagePath = path.join(
				path.resolve(props.cacheRoot),
				'hermes',
				'vm-images',
				image.metadata.fingerprint,
			);
			selected.push({
				...selection,
				recipeFingerprint: entry.recipeFingerprint,
				imagePath,
				selectedKernel: path.join(imagePath, 'vmlinuz-virt'),
				selectedInitrd: path.join(imagePath, 'initramfs.cpio.lz4'),
				metadata: image.metadata,
			});
		}
		const tool = selected[0];
		const gateway = selected[1];
		if (tool === undefined || gateway === undefined)
			return { status: 'unavailable', reason: 'invalid-selection' };
		return { status: 'available', images: [tool, gateway] };
	} catch {
		return { status: 'unavailable', reason: 'read-failed' };
	}
}
export function comparePostBootIdentity(
	input: BootImageInput,
	before: CacheObservation,
	after: CacheObservation,
): 'unchanged' | 'changed' | 'unavailable' {
	const image = after.images.find(
		(candidate) => candidate.family === input.family && candidate.name === input.name,
	);
	if (
		image?.metadata.status !== 'measured' ||
		after.preparedManifest.status !== 'measured' ||
		before.preparedManifest.status !== 'measured' ||
		image.metadata.assets.some((asset) => asset.bytes.status !== 'measured')
	)
		return 'unavailable';
	return before.preparedManifest.sha256 === after.preparedManifest.sha256 &&
		JSON.stringify(input.metadata) === JSON.stringify(image.metadata)
		? 'unchanged'
		: 'changed';
}
