/// <reference types="node" />
/// <reference lib="es2024" />
import { createHash } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
	InspectionFailure,
	inspectionLimits,
	inspectE2eImageCache,
	osInspectionIo,
	type CacheObservation,
	type InspectionIo,
} from './inspect-e2e-image-cache.ts';
import {
	comparePostBootIdentity,
	selectBootProbeInputs,
	type BootImageInput,
} from './probe-e2e-image-boot-inputs.ts';
import { osOwnedProcessIo } from './probe-e2e-image-boot-process.ts';
import {
	probeOneImage,
	resolvePinnedGondolinSdk,
	type BootProbeRecord,
	type ProbeDependencies,
} from './probe-e2e-image-boot.ts';

interface KernelHeaderFields {
	readonly status: 'measured-bzimage';
	readonly kernelSha256: string;
	readonly protocol: number;
	readonly initrdAddrMax: number;
	readonly xloadflags: number | null;
}
type MeasuredKernelHeader = KernelHeaderFields &
	(
		| { readonly applicability: 'necessary-page-match' }
		| { readonly applicability: 'hypothesis-not-applicable' }
	);
type KernelHeaderObservation =
	| MeasuredKernelHeader
	| { readonly status: 'short' | 'not-bzimage'; readonly kernelSha256: string }
	| {
			readonly status: 'unavailable';
			readonly reason:
				| 'missing'
				| 'unsafe-path'
				| 'invalid-size'
				| 'over-limit'
				| 'read-failed'
				| 'unmeasured-kernel';
	  }
	| {
			readonly status: 'changed';
			readonly reason: 'size-mismatch' | 'hash-mismatch' | 'identity-changed' | 'over-limit';
	  };
interface KernelHeaderResult {
	readonly observation: KernelHeaderObservation;
	readonly primaryError: unknown;
}
interface MemoryComparisonMetadata {
	readonly schemaVersion: 1;
	readonly kind: 'stock-sdk-image-memory-comparison';
	readonly comparison: 'tool-2049m-after-2g-baseline';
	readonly requestedMemory: '2049M';
	readonly provenance: CacheObservation['provenance'];
}
export type MemoryComparisonRecord = MemoryComparisonMetadata &
	(
		| {
				readonly inputStatus: 'available';
				readonly kernelHeader: Extract<
					MeasuredKernelHeader,
					{ readonly applicability: 'necessary-page-match' }
				>;
				readonly probe: BootProbeRecord;
		  }
		| {
				readonly inputStatus: Exclude<BootProbeRecord['inputStatus'], 'available'>;
				readonly kernelHeader: { readonly status: 'not-read' };
				readonly probe: null;
		  }
		| {
				readonly inputStatus: 'hypothesis-not-applicable';
				readonly kernelHeader: Extract<
					MeasuredKernelHeader,
					{ readonly applicability: 'hypothesis-not-applicable' }
				>;
				readonly probe: null;
		  }
		| {
				readonly inputStatus: 'kernel-header-unavailable';
				readonly kernelHeader: Extract<
					KernelHeaderObservation,
					{ readonly status: 'unavailable' | 'short' | 'not-bzimage' }
				>;
				readonly probe: null;
		  }
		| {
				readonly inputStatus: 'kernel-header-changed';
				readonly kernelHeader: Extract<KernelHeaderObservation, { readonly status: 'changed' }>;
				readonly probe: null;
		  }
	);
async function observeSelectedKernelHeader(props: {
	readonly input: BootImageInput;
	readonly io: InspectionIo;
}): Promise<KernelHeaderResult> {
	const expected = props.input.metadata.assets.find((asset) => asset.role === 'kernel')?.bytes;
	if (expected?.status !== 'measured')
		return {
			observation: { status: 'unavailable', reason: 'unmeasured-kernel' },
			primaryError: null,
		};
	try {
		if ((await props.io.lstat(props.input.imagePath)).kind !== 'directory')
			return { observation: { status: 'unavailable', reason: 'unsafe-path' }, primaryError: null };
		const info = await props.io.lstat(props.input.selectedKernel);
		const canonicalImage = await props.io.realpath(props.input.imagePath);
		const canonicalKernel = await props.io.realpath(props.input.selectedKernel);
		if (
			info.kind !== 'file' ||
			!path.isAbsolute(canonicalImage) ||
			canonicalKernel !== path.join(canonicalImage, 'vmlinuz-virt')
		)
			return { observation: { status: 'unavailable', reason: 'unsafe-path' }, primaryError: null };
		if (info.sizeBytes !== expected.sizeBytes)
			return { observation: { status: 'changed', reason: 'size-mismatch' }, primaryError: null };
		if (!Number.isSafeInteger(info.sizeBytes) || info.sizeBytes <= 0)
			return { observation: { status: 'unavailable', reason: 'invalid-size' }, primaryError: null };
		if (info.sizeBytes > inspectionLimits.kernel)
			return { observation: { status: 'unavailable', reason: 'over-limit' }, primaryError: null };
		const prefix = Buffer.alloc(0x238);
		const hash = createHash('sha256');
		let sizeBytes = 0;
		for await (const chunk of props.io.readChunks({
			filePath: props.input.selectedKernel,
			identity: info.identity,
			maxBytes: inspectionLimits.kernel,
		})) {
			const offset = sizeBytes;
			sizeBytes += chunk.byteLength;
			if (sizeBytes > inspectionLimits.kernel)
				return { observation: { status: 'changed', reason: 'over-limit' }, primaryError: null };
			hash.update(chunk);
			if (offset < prefix.byteLength)
				prefix.set(
					chunk.subarray(0, Math.min(chunk.byteLength, prefix.byteLength - offset)),
					offset,
				);
		}
		// Complete iteration is required: InspectionIo checks end identity and closes its handle.
		if (sizeBytes !== info.sizeBytes || sizeBytes !== expected.sizeBytes)
			return { observation: { status: 'changed', reason: 'size-mismatch' }, primaryError: null };
		const kernelSha256 = hash.digest('hex');
		if (kernelSha256 !== expected.sha256)
			return { observation: { status: 'changed', reason: 'hash-mismatch' }, primaryError: null };
		if (sizeBytes < prefix.byteLength)
			return { observation: { status: 'short', kernelSha256 }, primaryError: null };
		if (prefix.readUInt32LE(0x202) !== 0x53726448)
			return { observation: { status: 'not-bzimage', kernelSha256 }, primaryError: null };
		const protocol = prefix.readUInt16LE(0x206);
		const initrdAddrMax = prefix.readUInt32LE(0x22c);
		// QEMU v8.2.2 interprets xloadflags only for protocol >= 2.12.
		const xloadflags = protocol >= 0x20c ? prefix.readUInt16LE(0x236) : null;
		const fields = {
			status: 'measured-bzimage',
			kernelSha256,
			protocol,
			initrdAddrMax,
			xloadflags,
		} as const;
		const applicability =
			protocol >= 0x203 && Math.floor(initrdAddrMax / 4096) * 4096 === 0x7ffff000
				? 'necessary-page-match'
				: 'hypothesis-not-applicable';
		return { observation: { ...fields, applicability }, primaryError: null };
	} catch (error) {
		if (error instanceof InspectionFailure && error.status === 'changed-during-read')
			return {
				observation: { status: 'changed', reason: 'identity-changed' },
				primaryError: error,
			};
		const reason =
			error instanceof InspectionFailure &&
			(error.status === 'missing' ||
				error.status === 'unsafe-path' ||
				error.status === 'over-limit')
				? error.status
				: 'read-failed';
		return { observation: { status: 'unavailable', reason }, primaryError: error };
	}
}
export async function runMemoryProbe(dependencies: ProbeDependencies): Promise<{
	readonly record: MemoryComparisonRecord;
	readonly exitCode: 0 | 1;
	readonly primaryError: unknown;
}> {
	const before = await dependencies.inspect();
	const metadata: MemoryComparisonMetadata = {
		schemaVersion: 1,
		kind: 'stock-sdk-image-memory-comparison',
		comparison: 'tool-2049m-after-2g-baseline',
		requestedMemory: '2049M',
		provenance: before.provenance,
	};
	const inputs = await selectBootProbeInputs({
		observation: before,
		cacheRoot: dependencies.cacheRoot,
		io: dependencies.inputIo,
		environment: dependencies.environment,
	});
	if (inputs.status !== 'available')
		return {
			record: {
				...metadata,
				inputStatus: inputs.reason,
				kernelHeader: { status: 'not-read' },
				probe: null,
			},
			exitCode: 0,
			primaryError: null,
		};
	const tool = inputs.images[0];
	const header = await observeSelectedKernelHeader({ input: tool, io: dependencies.inputIo });
	const kernelHeader = header.observation;
	switch (kernelHeader.status) {
		case 'changed':
			return {
				record: { ...metadata, inputStatus: 'kernel-header-changed', kernelHeader, probe: null },
				exitCode: 1,
				primaryError: header.primaryError,
			};
		case 'unavailable':
		case 'short':
		case 'not-bzimage':
			return {
				record: {
					...metadata,
					inputStatus: 'kernel-header-unavailable',
					kernelHeader,
					probe: null,
				},
				exitCode: 0,
				primaryError: header.primaryError,
			};
		case 'measured-bzimage':
			if (kernelHeader.applicability === 'hypothesis-not-applicable')
				return {
					record: {
						...metadata,
						inputStatus: 'hypothesis-not-applicable',
						kernelHeader,
						probe: null,
					},
					exitCode: 0,
					primaryError: null,
				};
	}
	// This necessary header condition permits an experiment; it does not prove ACPI overlap.
	const result = await probeOneImage({
		input: tool,
		observation: before,
		sdk: dependencies.sdk,
		processIo: dependencies.processIo,
		now: dependencies.now,
		memory: '2049M',
	});
	const after = await dependencies.inspect();
	const postBootAssetIdentity = comparePostBootIdentity(tool, before, after);
	return {
		record: {
			...metadata,
			inputStatus: 'available',
			kernelHeader,
			probe: { ...result.record, postBootAssetIdentity },
		},
		exitCode: result.exitCode === 0 && postBootAssetIdentity === 'unchanged' ? 0 : 1,
		primaryError: result.primaryError,
	};
}
async function main(): Promise<void> {
	const cacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR ?? '/tmp/agent-vm-e2e-cache';
	const { sdk } = await resolvePinnedGondolinSdk();
	const result = await runMemoryProbe({
		sdk,
		cacheRoot,
		environment: process.env,
		now: () => performance.now(),
		processIo: osOwnedProcessIo,
		inputIo: osInspectionIo,
		inspect: async () =>
			await inspectE2eImageCache({ cacheRoot, environment: process.env, io: osInspectionIo }),
	});
	process.stdout.write(JSON.stringify(result.record) + '\n');
	process.exitCode = result.exitCode;
}
if (
	process.argv[1] !== undefined &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main().catch(() => {
		process.stderr.write('stock-sdk-image-memory-probe: unexpected-crash\n');
		process.exitCode = 1;
	});
}
