/// <reference types="node" />
/// <reference lib="es2024" />
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
	inspectE2eImageCache,
	osInspectionIo,
	type CacheObservation,
	type InspectionIo,
} from './inspect-e2e-image-cache.ts';
import {
	selectBootProbeInputs,
	comparePostBootIdentity,
	type BootImageInput,
} from './probe-e2e-image-boot-inputs.ts';
import {
	captureOwnedProcess,
	observeOwnedRunnerExit,
	osOwnedProcessIo,
	type OwnedProcessCapture,
	type OwnedProcessIo,
} from './probe-e2e-image-boot-process.ts';
import {
	createProbeBootSignalTracker,
	type ProbeBootSignals,
} from './probe-e2e-image-boot-signals.ts';

type ProbeMemory = '1G' | '2G';

export interface PublicProbeVm {
	start(): Promise<void>;
	close(): Promise<void>;
	getHostPid?: () => number | null;
}
export interface ProbeVmOptions {
	readonly sandbox: { readonly imagePath: string; readonly debug: readonly ['protocol', 'vfs'] };
	readonly rootfs: { readonly mode: 'cow'; readonly size: '12G' };
	readonly memory: ProbeMemory;
	readonly cpus: 1;
	readonly env: Readonly<Record<string, string>>;
	readonly httpHooks: unknown;
	readonly vfs: { readonly fuseMount: '/data'; readonly mounts: Readonly<Record<string, never>> };
	readonly debugLog: (component: string, message: string) => void;
}
export interface PublicProbeSdk {
	readonly VM: { create(options: ProbeVmOptions): Promise<PublicProbeVm> };
	createHttpHooks(options: {
		readonly secretPlaceholderMode: 'unique';
		readonly allowedHosts: readonly [];
		readonly secrets: Readonly<Record<string, never>>;
	}): {
		readonly env: Readonly<Record<string, string>>;
		readonly httpHooks: unknown;
	};
}
type StartupObservation =
	| { readonly phase: 'create'; readonly status: 'failed' }
	| { readonly phase: 'start'; readonly status: 'ready' | 'timeout' | 'failed' }
	| { readonly phase: 'not-run'; readonly reason: 'invalid-input' | 'prior-cleanup-unverified' };
export interface BootProbeRecord {
	readonly schemaVersion: 1;
	readonly kind: 'stock-sdk-image-boot-probe';
	readonly family: 'toolVm' | 'gateway';
	readonly name: 'default' | 'hermes';
	readonly caller: 'isolated-public-sdk-no-managed-input-mounts';
	readonly sdkVersion: '0.13.0';
	readonly stockReadinessDefaultMs: 120000;
	readonly requestedMemory: ProbeMemory;
	readonly provenance: CacheObservation['provenance'];
	readonly binding: {
		readonly recipeFingerprint: string;
		readonly image: BootImageInput['metadata'];
	} | null;
	readonly inputStatus:
		| 'available'
		| 'different-experiment'
		| 'invalid-assets'
		| 'invalid-selection'
		| 'read-failed'
		| 'custom-start-timeout';
	readonly startup: StartupObservation;
	readonly beforeClose: ProbeBootSignals | null;
	readonly afterClose: ProbeBootSignals | null;
	readonly process: OwnedProcessCapture['observation'];
	readonly processCaptureTiming: 'first-qemu-event' | 'after-start' | 'unavailable';
	readonly cleanup: {
		readonly close: 'resolved' | 'rejected' | 'not-created';
		readonly runner: 'exited' | 'still-observed' | 'unknown';
		readonly cowAndFdCleanup: 'sdk-owner-not-independently-observed';
	};
	readonly postBootAssetIdentity: 'unchanged' | 'changed' | 'unavailable';
}
interface ImageProbeResult {
	readonly record: BootProbeRecord;
	readonly primaryError: unknown;
	readonly cleanupError: unknown;
	readonly exitCode: 0 | 1;
}
export interface ProbeDependencies {
	readonly sdk: PublicProbeSdk;
	readonly processIo: OwnedProcessIo;
	readonly now: () => number;
	readonly inspect: () => Promise<CacheObservation>;
	readonly cacheRoot: string;
	readonly inputIo: InspectionIo;
	readonly environment: Readonly<Record<string, string | undefined>>;
}
function baseRecord(
	selection: { readonly family: 'toolVm' | 'gateway'; readonly name: 'default' | 'hermes' },
	provenance: CacheObservation['provenance'],
): BootProbeRecord {
	return {
		schemaVersion: 1,
		kind: 'stock-sdk-image-boot-probe',
		family: selection.family,
		name: selection.name,
		caller: 'isolated-public-sdk-no-managed-input-mounts',
		sdkVersion: '0.13.0',
		stockReadinessDefaultMs: 120000,
		requestedMemory: '2G',
		provenance,
		binding: null,
		inputStatus: 'available',
		startup: { phase: 'not-run', reason: 'invalid-input' },
		beforeClose: null,
		afterClose: null,
		process: { status: 'missing' },
		processCaptureTiming: 'unavailable',
		cleanup: {
			close: 'not-created',
			runner: 'unknown',
			cowAndFdCleanup: 'sdk-owner-not-independently-observed',
		},
		postBootAssetIdentity: 'unavailable',
	};
}
export async function probeOneImage(props: {
	readonly input: BootImageInput;
	readonly observation: CacheObservation;
	readonly sdk: PublicProbeSdk;
	readonly processIo: OwnedProcessIo;
	readonly now: () => number;
	readonly memory?: ProbeMemory;
}): Promise<ImageProbeResult> {
	const requestedMemory: ProbeMemory = props.memory ?? '2G';
	const tracker = createProbeBootSignalTracker(props.now);
	let vm: PublicProbeVm | undefined;
	let capturePromise: Promise<OwnedProcessCapture> | undefined;
	let capture: OwnedProcessCapture = { observation: { status: 'missing' }, identity: null };
	let captureTiming: BootProbeRecord['processCaptureTiming'] = 'unavailable';
	let captureOpen = true;
	let startup: StartupObservation = { phase: 'create', status: 'failed' };
	let primaryError: unknown = null;
	let cleanupError: unknown = null;
	let beforeClose: ProbeBootSignals | null = null;
	let afterClose: ProbeBootSignals | null = null;
	let close: BootProbeRecord['cleanup']['close'] = 'not-created';
	let runner: BootProbeRecord['cleanup']['runner'] = 'unknown';
	function beginCapture(timing: 'first-qemu-event' | 'after-start'): void {
		if (!captureOpen || capturePromise !== undefined || vm === undefined) return;
		const ownedVm = vm;
		if (ownedVm.getHostPid === undefined) {
			capture = { observation: { status: 'unsupported' }, identity: null };
			return;
		}
		let pid: number | null;
		try {
			pid = ownedVm.getHostPid();
		} catch {
			capture = { observation: { status: 'read-failed' }, identity: null };
			return;
		}
		if (pid === null || !Number.isSafeInteger(pid) || pid <= 0) return;
		captureTiming = timing;
		// One asynchronous read sequence, retained through SDK-owned timeout teardown.
		capturePromise = captureOwnedProcess({
			io: props.processIo,
			pid,
			getHostPid: () => ownedVm.getHostPid?.() ?? null,
			selectedKernel: props.input.selectedKernel,
			selectedInitrd: props.input.selectedInitrd,
		});
	}
	const debugLog = (component: string, message: string): void => {
		tracker.observe(component, message);
		if (component === 'qemu') beginCapture('first-qemu-event');
	};
	try {
		const hooks = props.sdk.createHttpHooks({
			secretPlaceholderMode: 'unique',
			allowedHosts: [],
			secrets: {},
		});
		vm = await props.sdk.VM.create({
			sandbox: { imagePath: props.input.imagePath, debug: ['protocol', 'vfs'] },
			rootfs: { mode: 'cow', size: '12G' },
			memory: requestedMemory,
			cpus: 1,
			env: { ...hooks.env },
			httpHooks: hooks.httpHooks,
			vfs: { fuseMount: '/data', mounts: {} },
			debugLog,
		});
		startup = { phase: 'start', status: 'ready' };
		try {
			await vm.start();
		} catch (error) {
			primaryError = error;
			const code =
				typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
			startup = { phase: 'start', status: code === 'vm_start_timeout' ? 'timeout' : 'failed' };
		}
		// If no QEMU event carried a PID, this fallback honestly may lose to SDK teardown.
		beginCapture('after-start');
		if (capturePromise !== undefined) capture = await capturePromise;
		beforeClose = tracker.snapshot();
	} catch (error) {
		primaryError = error;
		if (vm !== undefined) throw error;
	} finally {
		captureOpen = false;
		if (vm !== undefined) {
			try {
				await vm.close();
				close = 'resolved';
			} catch (error) {
				cleanupError = error;
				close = 'rejected';
			}
			afterClose = tracker.snapshot();
			runner = await observeOwnedRunnerExit(capture.identity, props.processIo);
		}
		tracker.stop();
	}
	const record: BootProbeRecord = {
		...baseRecord(props.input, props.observation.provenance),
		requestedMemory,
		binding: { recipeFingerprint: props.input.recipeFingerprint, image: props.input.metadata },
		startup,
		beforeClose,
		afterClose,
		process: capture.observation,
		processCaptureTiming: captureTiming,
		cleanup: { close, runner, cowAndFdCleanup: 'sdk-owner-not-independently-observed' },
	};
	return {
		record,
		primaryError,
		cleanupError,
		exitCode: close === 'resolved' && runner === 'exited' ? 0 : 1,
	};
}
export async function runBootProbe(dependencies: ProbeDependencies): Promise<{
	readonly records: readonly BootProbeRecord[];
	readonly exitCode: 0 | 1;
	readonly primaryErrors: readonly unknown[];
}> {
	const before = await dependencies.inspect();
	const inputs = await selectBootProbeInputs({
		observation: before,
		cacheRoot: dependencies.cacheRoot,
		io: dependencies.inputIo,
		environment: dependencies.environment,
	});
	if (inputs.status !== 'available') {
		return {
			exitCode: 0,
			primaryErrors: [],
			records: [
				{
					...baseRecord({ family: 'toolVm', name: 'default' }, before.provenance),
					inputStatus: inputs.reason,
				},
				{
					...baseRecord({ family: 'gateway', name: 'hermes' }, before.provenance),
					inputStatus: inputs.reason,
				},
			],
		};
	}
	const tool = await probeOneImage({
		input: inputs.images[0],
		observation: before,
		sdk: dependencies.sdk,
		processIo: dependencies.processIo,
		now: dependencies.now,
	});
	const gateway: ImageProbeResult =
		tool.exitCode === 0
			? await probeOneImage({
					input: inputs.images[1],
					observation: before,
					sdk: dependencies.sdk,
					processIo: dependencies.processIo,
					now: dependencies.now,
				})
			: {
					record: {
						...baseRecord(inputs.images[1], before.provenance),
						binding: {
							recipeFingerprint: inputs.images[1].recipeFingerprint,
							image: inputs.images[1].metadata,
						},
						startup: { phase: 'not-run', reason: 'prior-cleanup-unverified' },
					},
					exitCode: 1,
					primaryError: null,
					cleanupError: null,
				};
	const after = await dependencies.inspect();
	const records: readonly BootProbeRecord[] = [
		{
			...tool.record,
			postBootAssetIdentity: comparePostBootIdentity(inputs.images[0], before, after),
		},
		{
			...gateway.record,
			postBootAssetIdentity: comparePostBootIdentity(inputs.images[1], before, after),
		},
	];
	return {
		records,
		primaryErrors: [tool.primaryError, gateway.primaryError],
		exitCode:
			tool.exitCode !== 0 ||
			gateway.exitCode !== 0 ||
			records.some((record) => record.postBootAssetIdentity !== 'unchanged')
				? 1
				: 0,
	};
}
function isContainer(value: unknown): value is Record<string, unknown> {
	return value !== null && (typeof value === 'object' || typeof value === 'function');
}
function hasPublicSdk(value: unknown): value is PublicProbeSdk {
	return (
		isContainer(value) &&
		isContainer(value.VM) &&
		typeof value.VM.create === 'function' &&
		typeof value.createHttpHooks === 'function'
	);
}
export async function resolvePinnedGondolinSdk(): Promise<{
	readonly sdk: PublicProbeSdk;
	readonly version: '0.13.0';
	readonly publicMethodsPresent: boolean;
}> {
	const requireFromAdapter = createRequire(
		new URL('../packages/gondolin-vm-adapter/package.json', import.meta.url),
	);
	const manifest: unknown = JSON.parse(
		await readFile(requireFromAdapter.resolve('@earendil-works/gondolin/package.json'), 'utf8'),
	);
	if (
		!isContainer(manifest) ||
		manifest.name !== '@earendil-works/gondolin' ||
		manifest.version !== '0.13.0'
	)
		throw new Error('unsupported-sdk-identity');
	const namespace: unknown = await import(
		pathToFileURL(requireFromAdapter.resolve('@earendil-works/gondolin')).href
	);
	if (!hasPublicSdk(namespace)) throw new Error('unsupported-sdk-api');
	const vmClass: unknown = namespace.VM;
	const prototype = isContainer(vmClass) ? vmClass.prototype : undefined;
	const publicMethodsPresent =
		isContainer(prototype) &&
		typeof prototype.start === 'function' &&
		typeof prototype.close === 'function' &&
		typeof prototype.getHostPid === 'function';
	return { sdk: namespace, version: '0.13.0', publicMethodsPresent };
}
async function main(): Promise<void> {
	const cacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR ?? '/tmp/agent-vm-e2e-cache';
	const { sdk } = await resolvePinnedGondolinSdk();
	const result = await runBootProbe({
		sdk,
		cacheRoot,
		environment: process.env,
		now: () => performance.now(),
		processIo: osOwnedProcessIo,
		inputIo: osInspectionIo,
		inspect: async () =>
			await inspectE2eImageCache({ cacheRoot, environment: process.env, io: osInspectionIo }),
	});
	for (const record of result.records) process.stdout.write(JSON.stringify(record) + '\n');
	process.exitCode = result.exitCode;
}
if (
	process.argv[1] !== undefined &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main().catch(() => {
		process.stderr.write('stock-sdk-image-boot-probe: unexpected-crash\n');
		process.exitCode = 1;
	});
}
