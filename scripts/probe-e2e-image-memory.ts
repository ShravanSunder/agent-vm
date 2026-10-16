/// <reference types="node" />
/// <reference lib="es2024" />
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
	inspectE2eImageCache,
	osInspectionIo,
	type CacheObservation,
} from './inspect-e2e-image-cache.ts';
import { comparePostBootIdentity, selectBootProbeInputs } from './probe-e2e-image-boot-inputs.ts';
import { osOwnedProcessIo } from './probe-e2e-image-boot-process.ts';
import {
	probeOneImage,
	resolvePinnedGondolinSdk,
	type BootProbeRecord,
	type ProbeDependencies,
} from './probe-e2e-image-boot.ts';

interface MemoryComparisonMetadata {
	readonly schemaVersion: 1;
	readonly kind: 'stock-sdk-image-memory-comparison';
	readonly comparison: 'tool-1g-after-2g-baseline';
	readonly requestedMemory: '1G';
	readonly provenance: CacheObservation['provenance'];
}
export type MemoryComparisonRecord = MemoryComparisonMetadata &
	(
		| { readonly inputStatus: 'available'; readonly probe: BootProbeRecord }
		| {
				readonly inputStatus: Exclude<BootProbeRecord['inputStatus'], 'available'>;
				readonly probe: null;
		  }
	);
export async function runMemoryProbe(dependencies: ProbeDependencies): Promise<{
	readonly record: MemoryComparisonRecord;
	readonly exitCode: 0 | 1;
	readonly primaryError: unknown;
}> {
	const before = await dependencies.inspect();
	const metadata: MemoryComparisonMetadata = {
		schemaVersion: 1,
		kind: 'stock-sdk-image-memory-comparison',
		comparison: 'tool-1g-after-2g-baseline',
		requestedMemory: '1G',
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
			record: { ...metadata, inputStatus: inputs.reason, probe: null },
			exitCode: 0,
			primaryError: null,
		};
	// The same retained Tool image follows the unchanged two-image 2G CI baseline.
	const tool = inputs.images[0];
	const result = await probeOneImage({
		input: tool,
		observation: before,
		sdk: dependencies.sdk,
		processIo: dependencies.processIo,
		now: dependencies.now,
		memory: '1G',
	});
	const after = await dependencies.inspect();
	const postBootAssetIdentity = comparePostBootIdentity(tool, before, after);
	return {
		record: {
			...metadata,
			inputStatus: 'available',
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
