/// <reference types="node" />
/// <reference lib="es2024" />
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mebibyte = 1024 * 1024;
// SDK 0.13 build/shared.js owns these filenames. Caps bound observation, not image admission.
export const inspectionLimits = {
	preparedManifestBytes: 256 * 1024,
	imageManifestBytes: 128 * 1024,
	manifestEntries: 32,
	kernel: 64 * mebibyte,
	initramfs: 512 * mebibyte,
	rootfs: 16 * 1024 * mebibyte,
	krunKernel: 512 * mebibyte,
	krunInitrd: mebibyte,
} as const;
const assetDefinitions = [
	{ role: 'kernel', fileName: 'vmlinuz-virt', optional: false },
	{ role: 'initramfs', fileName: 'initramfs.cpio.lz4', optional: false },
	{ role: 'rootfs', fileName: 'rootfs.ext4', optional: false },
	{ role: 'krunKernel', fileName: 'krun-kernel', optional: true },
	{ role: 'krunInitrd', fileName: 'krun-empty-initrd', optional: true },
] as const;
const imageSelections = [
	{ family: 'gateway', name: 'hermes' },
	{ family: 'toolVm', name: 'default' },
] as const;
type AssetRole = (typeof assetDefinitions)[number]['role'];
type ImageSelection = (typeof imageSelections)[number];
type FailureStatus =
	| 'missing'
	| 'malformed'
	| 'unsafe-path'
	| 'read-failed'
	| 'over-limit'
	| 'changed-during-read';
type Measurement<TFields> =
	| ({ readonly status: 'measured' } & TFields)
	| { readonly status: FailureStatus };
type CacheHit = 'hit' | 'miss' | 'unknown';
type DeclaredArchitecture = 'aarch64' | 'x86_64' | 'unknown';
type DeclaredDistro = 'alpine' | 'nixos' | 'unknown';

export class InspectionFailure extends Error {
	readonly status: FailureStatus;
	constructor(status: FailureStatus) {
		super(status);
		this.status = status;
		this.name = 'InspectionFailure';
	}
}
export interface InspectionPathInfo {
	readonly kind: 'file' | 'directory' | 'symlink' | 'other';
	readonly sizeBytes: number;
	readonly identity: string;
}
export interface InspectionIo {
	readonly lstat: (filePath: string) => Promise<InspectionPathInfo>;
	readonly realpath: (filePath: string) => Promise<string>;
	readonly readChunks: (props: {
		readonly filePath: string;
		readonly identity: string;
		readonly maxBytes: number;
	}) => AsyncIterable<Uint8Array>;
}
interface CacheProvenance {
	readonly inputHash: string | null;
	readonly preparationInputHash: string | null;
	readonly consumerPrimaryKey: string | null;
	readonly consumerCacheHit: CacheHit;
	readonly preparationLookup: CacheHit;
	readonly experiment: 'retained-cache' | 'rebuilt-cache' | 'unconfirmed';
}
interface AssetObservation {
	readonly role: AssetRole;
	readonly declaredSha256: string;
	readonly bytes: Measurement<{
		readonly sizeBytes: number;
		readonly sha256: string;
		readonly checksumMatch: boolean;
	}>;
}
interface ImageObservation {
	readonly family: ImageSelection['family'];
	readonly name: ImageSelection['name'];
	readonly metadata: Measurement<{
		readonly fingerprint: string;
		readonly manifestSha256: string;
		readonly configurationSha256: string;
		readonly declaredArchitecture: DeclaredArchitecture;
		readonly declaredDistro: DeclaredDistro;
		readonly assets: readonly AssetObservation[];
	}>;
}
export interface CacheObservation {
	readonly schemaVersion: 1;
	readonly kind: 'prepared-e2e-image-cache-observation';
	readonly provenance: CacheProvenance;
	readonly preparedManifest: Measurement<{ readonly sha256: string }>;
	readonly images: readonly ImageObservation[];
	readonly gatewayToolKernel: 'equal' | 'different' | 'unavailable';
}
interface InspectionOptions {
	readonly cacheRoot: string;
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly io: InspectionIo;
}
interface AssetEntry {
	readonly role: AssetRole;
	readonly fileName: string;
	readonly checksum: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function requireCondition(condition: boolean, status: FailureStatus): asserts condition {
	if (!condition) throw new InspectionFailure(status);
}
function sha256(bytes: Uint8Array | string): string {
	return createHash('sha256').update(bytes).digest('hex');
}
function digestValue(value: string | undefined): string | null {
	return value !== undefined && /^[a-f0-9]{64}$/u.test(value) ? value : null;
}
function cacheHit(value: string | undefined): CacheHit {
	if (value === 'true') return 'hit';
	if (value === 'false' || value === '') return 'miss';
	return 'unknown';
}
export function projectCacheProvenance(
	environment: InspectionOptions['environment'],
): CacheProvenance {
	const inputHash = digestValue(environment.CACHE_INSPECTION_INPUT_HASH);
	const preparationInputHash = digestValue(environment.CACHE_INSPECTION_PREPARATION_INPUT_HASH);
	const primaryKey = environment.CACHE_INSPECTION_PRIMARY_KEY;
	const consumerPrimaryKey =
		primaryKey !== undefined &&
		/^agent-vm-e2e-images-v1-hermes-(?:Linux|macOS|Windows)-[a-f0-9]{64}$/u.test(primaryKey)
			? primaryKey
			: null;
	const consumerCacheHit = cacheHit(environment.CACHE_INSPECTION_CACHE_HIT);
	const preparationLookup = cacheHit(environment.CACHE_INSPECTION_PREPARATION_LOOKUP_HIT);
	const correlated =
		inputHash !== null &&
		inputHash === preparationInputHash &&
		consumerPrimaryKey?.endsWith('-' + inputHash) === true &&
		consumerCacheHit === 'hit';
	return {
		inputHash,
		preparationInputHash,
		consumerPrimaryKey,
		consumerCacheHit,
		preparationLookup,
		experiment:
			correlated && preparationLookup === 'hit'
				? 'retained-cache'
				: correlated && preparationLookup === 'miss'
					? 'rebuilt-cache'
					: 'unconfirmed',
	};
}
async function measure<TFields>(operation: () => Promise<TFields>): Promise<Measurement<TFields>> {
	try {
		return { status: 'measured', ...(await operation()) };
	} catch (error) {
		if (error instanceof InspectionFailure) return { status: error.status };
		throw error;
	}
}
async function checkDirectory(props: {
	readonly io: InspectionIo;
	readonly directory: string;
	readonly expectedCanonical?: string;
}): Promise<string> {
	const info = await props.io.lstat(props.directory);
	requireCondition(info.kind === 'directory', 'unsafe-path');
	const canonical = await props.io.realpath(props.directory);
	requireCondition(
		props.expectedCanonical === undefined || canonical === props.expectedCanonical,
		'unsafe-path',
	);
	return canonical;
}
async function checkFile(props: {
	readonly io: InspectionIo;
	readonly filePath: string;
	readonly canonicalPath: string;
	readonly maxBytes: number;
}): Promise<InspectionPathInfo> {
	const info = await props.io.lstat(props.filePath);
	requireCondition(info.kind === 'file', 'unsafe-path');
	requireCondition(
		(await props.io.realpath(props.filePath)) === props.canonicalPath,
		'unsafe-path',
	);
	requireCondition(Number.isSafeInteger(info.sizeBytes) && info.sizeBytes >= 0, 'malformed');
	requireCondition(info.sizeBytes <= props.maxBytes, 'over-limit');
	return info;
}
async function readBoundedJson(props: {
	readonly io: InspectionIo;
	readonly filePath: string;
	readonly canonicalPath: string;
	readonly maxBytes: number;
}): Promise<{ readonly value: unknown; readonly sha256: string }> {
	const info = await checkFile(props);
	const chunks: Uint8Array[] = [];
	let sizeBytes = 0;
	for await (const chunk of props.io.readChunks({ ...props, identity: info.identity })) {
		sizeBytes += chunk.byteLength;
		requireCondition(sizeBytes <= props.maxBytes, 'over-limit');
		chunks.push(chunk);
	}
	requireCondition(sizeBytes === info.sizeBytes, 'changed-during-read');
	const bytes = Buffer.concat(chunks);
	let value: unknown;
	try {
		value = JSON.parse(bytes.toString('utf8'));
	} catch (error) {
		if (error instanceof SyntaxError) throw new InspectionFailure('malformed');
		throw error;
	}
	return { value, sha256: sha256(bytes) };
}
function canonicalJson(value: unknown, depth = 0): string {
	requireCondition(depth <= 32, 'over-limit');
	if (Array.isArray(value))
		return '[' + value.map((item: unknown) => canonicalJson(item, depth + 1)).join(',') + ']';
	if (isRecord(value))
		return (
			'{' +
			Object.keys(value)
				.toSorted()
				.map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key], depth + 1))
				.join(',') +
			'}'
		);
	return JSON.stringify(value) ?? 'null';
}
function parseAssetEntries(value: Record<string, unknown>): readonly AssetEntry[] {
	requireCondition(
		value.version === 1 &&
			isRecord(value.config) &&
			isRecord(value.assets) &&
			isRecord(value.checksums),
		'malformed',
	);
	const assets = value.assets;
	const checksums = value.checksums;
	requireCondition(isRecord(assets) && isRecord(checksums), 'malformed');
	const knownRoles = new Set<string>(assetDefinitions.map((entry) => entry.role));
	requireCondition(
		Object.keys(assets).every((role) => knownRoles.has(role)) &&
			Object.keys(checksums).every((role) => knownRoles.has(role)),
		'malformed',
	);
	const entries: AssetEntry[] = [];
	for (const definition of assetDefinitions) {
		const fileName = assets[definition.role];
		const checksum = checksums[definition.role];
		if (definition.optional && fileName === undefined && checksum === undefined) continue;
		requireCondition(
			fileName === definition.fileName &&
				typeof checksum === 'string' &&
				/^[a-f0-9]{64}$/u.test(checksum),
			'malformed',
		);
		entries.push({ role: definition.role, fileName: definition.fileName, checksum });
	}
	return entries;
}
async function observeAsset(props: {
	readonly io: InspectionIo;
	readonly imagePath: string;
	readonly canonicalImagePath: string;
	readonly entry: AssetEntry;
}): Promise<AssetObservation> {
	const { entry, io } = props;
	const maxBytes = inspectionLimits[entry.role];
	const filePath = path.join(props.imagePath, entry.fileName);
	const bytes = await measure(async () => {
		const info = await checkFile({
			io,
			filePath,
			canonicalPath: path.join(props.canonicalImagePath, entry.fileName),
			maxBytes,
		});
		requireCondition(info.sizeBytes > 0 || entry.role === 'krunInitrd', 'malformed');
		const hash = createHash('sha256');
		let sizeBytes = 0;
		for await (const chunk of io.readChunks({ filePath, identity: info.identity, maxBytes })) {
			sizeBytes += chunk.byteLength;
			requireCondition(sizeBytes <= maxBytes, 'over-limit');
			hash.update(chunk);
		}
		requireCondition(sizeBytes === info.sizeBytes, 'changed-during-read');
		const actualSha256 = hash.digest('hex');
		return { sizeBytes, sha256: actualSha256, checksumMatch: actualSha256 === entry.checksum };
	});
	return { role: entry.role, declaredSha256: entry.checksum, bytes };
}
async function observeImage(props: {
	readonly selection: ImageSelection;
	readonly entries: readonly unknown[];
	readonly hermesRoot: string;
	readonly canonicalHermesRoot: string;
	readonly io: InspectionIo;
}): Promise<ImageObservation> {
	const metadata = await measure(async () => {
		const matches = props.entries.filter(
			(entry) =>
				isRecord(entry) &&
				entry.family === props.selection.family &&
				entry.name === props.selection.name,
		);
		requireCondition(matches.length > 0, 'missing');
		requireCondition(matches.length === 1, 'malformed');
		const entry = matches[0];
		requireCondition(
			isRecord(entry) &&
				typeof entry.fingerprint === 'string' &&
				/^[a-f0-9]{16}$/u.test(entry.fingerprint),
			'malformed',
		);
		const fingerprint = entry.fingerprint;
		const imageCache = path.join(props.hermesRoot, 'vm-images');
		const imagePath = path.join(imageCache, fingerprint);
		requireCondition(
			typeof entry.imagePath === 'string' &&
				path.isAbsolute(entry.imagePath) &&
				path.resolve(entry.imagePath) === imagePath &&
				typeof entry.cacheDirectory === 'string' &&
				path.isAbsolute(entry.cacheDirectory) &&
				path.resolve(entry.cacheDirectory) === imageCache,
			'unsafe-path',
		);
		const canonicalCache = await checkDirectory({
			io: props.io,
			directory: imageCache,
			expectedCanonical: path.join(props.canonicalHermesRoot, 'vm-images'),
		});
		const canonicalImagePath = await checkDirectory({
			io: props.io,
			directory: imagePath,
			expectedCanonical: path.join(canonicalCache, fingerprint),
		});
		const manifest = await readBoundedJson({
			io: props.io,
			filePath: path.join(imagePath, 'manifest.json'),
			canonicalPath: path.join(canonicalImagePath, 'manifest.json'),
			maxBytes: inspectionLimits.imageManifestBytes,
		});
		requireCondition(isRecord(manifest.value), 'malformed');
		const value = manifest.value;
		const assetEntries = parseAssetEntries(value);
		requireCondition(isRecord(value.config), 'malformed');
		const configurationSha256 = sha256(
			canonicalJson({
				config: value.config,
				runtimeDefaults: value.runtimeDefaults ?? null,
				ociSource: value.ociSource ?? null,
			}),
		);
		const assets: AssetObservation[] = [];
		// Serial reads cap the working set; no VM, copy, preparation or selection mutation occurs.
		for (const assetEntry of assetEntries) {
			assets.push(
				// oxlint-disable-next-line no-await-in-loop -- bounded serial hashing prevents parallel image reads.
				await observeAsset({ io: props.io, imagePath, canonicalImagePath, entry: assetEntry }),
			);
		}
		const declaredArchitecture: DeclaredArchitecture =
			value.config.arch === 'aarch64' || value.config.arch === 'x86_64'
				? value.config.arch
				: 'unknown';
		const declaredDistro: DeclaredDistro =
			value.config.distro === 'alpine' || value.config.distro === 'nixos'
				? value.config.distro
				: 'unknown';
		return {
			fingerprint,
			manifestSha256: manifest.sha256,
			configurationSha256,
			declaredArchitecture,
			declaredDistro,
			assets,
		};
	});
	return { ...props.selection, metadata };
}
export async function inspectE2eImageCache(options: InspectionOptions): Promise<CacheObservation> {
	const root = path.resolve(options.cacheRoot);
	const prepared = await measure(async () => {
		const canonicalRoot = await checkDirectory({ io: options.io, directory: root });
		const hermesRoot = path.join(root, 'hermes');
		const canonicalHermesRoot = await checkDirectory({
			io: options.io,
			directory: hermesRoot,
			expectedCanonical: path.join(canonicalRoot, 'hermes'),
		});
		const manifest = await readBoundedJson({
			io: options.io,
			filePath: path.join(hermesRoot, 'prepared-e2e-images.json'),
			canonicalPath: path.join(canonicalHermesRoot, 'prepared-e2e-images.json'),
			maxBytes: inspectionLimits.preparedManifestBytes,
		});
		const value = manifest.value;
		requireCondition(
			isRecord(value) && value.schemaVersion === 2 && Array.isArray(value.entries),
			'malformed',
		);
		requireCondition(Array.isArray(value.entries), 'malformed');
		requireCondition(value.entries.length <= inspectionLimits.manifestEntries, 'over-limit');
		const images: ImageObservation[] = [];
		for (const selection of imageSelections) {
			images.push(
				// oxlint-disable-next-line no-await-in-loop -- the two selected images share the same sequential read budget.
				await observeImage({
					selection,
					entries: value.entries,
					hermesRoot,
					canonicalHermesRoot,
					io: options.io,
				}),
			);
		}
		return { sha256: manifest.sha256, images };
	});
	const images: readonly ImageObservation[] =
		prepared.status === 'measured'
			? prepared.images
			: imageSelections.map((selection) => ({
					family: selection.family,
					name: selection.name,
					metadata: { status: prepared.status },
				}));
	const kernels = images.map((image) =>
		image.metadata.status === 'measured'
			? image.metadata.assets.find((asset) => asset.role === 'kernel')?.bytes
			: undefined,
	);
	const gatewayKernel = kernels[0];
	const toolKernel = kernels[1];
	const gatewayToolKernel =
		gatewayKernel?.status === 'measured' && toolKernel?.status === 'measured'
			? gatewayKernel.sha256 === toolKernel.sha256
				? 'equal'
				: 'different'
			: 'unavailable';
	return {
		schemaVersion: 1,
		kind: 'prepared-e2e-image-cache-observation',
		provenance: projectCacheProvenance(options.environment),
		preparedManifest:
			prepared.status === 'measured' ? { status: 'measured', sha256: prepared.sha256 } : prepared,
		images,
		gatewayToolKernel,
	};
}
function pathIdentity(info: Awaited<ReturnType<typeof lstat>>): string {
	return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
}
function classifyIoFailure(error: unknown): never {
	if (error instanceof InspectionFailure) throw error;
	if (isRecord(error) && typeof error.code === 'string') {
		if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new InspectionFailure('missing');
		if (error.code === 'ELOOP') throw new InspectionFailure('unsafe-path');
		throw new InspectionFailure('read-failed');
	}
	throw error;
}
const osInspectionIo: InspectionIo = {
	async lstat(filePath) {
		try {
			const info = await lstat(filePath);
			return {
				kind: info.isSymbolicLink()
					? 'symlink'
					: info.isDirectory()
						? 'directory'
						: info.isFile()
							? 'file'
							: 'other',
				sizeBytes: info.size,
				identity: pathIdentity(info),
			};
		} catch (error) {
			return classifyIoFailure(error);
		}
	},
	async realpath(filePath) {
		try {
			return await realpath(filePath);
		} catch (error) {
			return classifyIoFailure(error);
		}
	},
	async *readChunks(props) {
		try {
			// No-follow and nonblocking refuse symlinks/FIFOs raced in after lstat.
			const handle = await open(
				props.filePath,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			try {
				const before = await handle.stat();
				requireCondition(before.isFile(), 'unsafe-path');
				requireCondition(pathIdentity(before) === props.identity, 'changed-during-read');
				for await (const chunk of handle.createReadStream({
					autoClose: false,
					highWaterMark: 64 * 1024,
					start: 0,
					end: props.maxBytes,
				})) {
					if (!Buffer.isBuffer(chunk)) throw new Error('invalid-binary-chunk');
					yield chunk;
				}
				requireCondition(
					pathIdentity(await handle.stat()) === props.identity,
					'changed-during-read',
				);
			} finally {
				await handle.close();
			}
		} catch (error) {
			classifyIoFailure(error);
		}
	},
};
async function main(): Promise<void> {
	const receipt = await inspectE2eImageCache({
		cacheRoot: process.env.AGENT_VM_E2E_CACHE_DIR ?? '/tmp/agent-vm-e2e-cache',
		environment: process.env,
		io: osInspectionIo,
	});
	process.stdout.write(JSON.stringify(receipt) + '\n');
}
if (
	process.argv[1] !== undefined &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main().catch(() => {
		// Unexpected crashes fail the step but cannot disclose arbitrary OS/input error text.
		process.stderr.write('prepared-e2e-image-cache-observation: unexpected-crash\n');
		process.exitCode = 1;
	});
}
