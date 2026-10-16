/// <reference types="node" />
/// <reference lib="es2024" />
import { createHash } from 'node:crypto';

import { type CacheObservation, type InspectionIo } from './inspect-e2e-image-cache.ts';
import { selectBootProbeInputs } from './probe-e2e-image-boot-inputs.ts';
import { ProcessReadFailure, type OwnedProcessIo } from './probe-e2e-image-boot-process.ts';
import {
	type probeOneImage,
	type ProbeDependencies,
	type ProbeVmOptions,
	type PublicProbeSdk,
} from './probe-e2e-image-boot.ts';

export const cacheRoot = '/fixture-private-cache';
const inputHash = 'a'.repeat(64);
export const toolFingerprint = '2'.repeat(16);
export const gatewayFingerprint = '1'.repeat(16);
export const imagePath = (fingerprint: string): string =>
	cacheRoot + '/hermes/vm-images/' + fingerprint;
export const rawManifest = {
	schemaVersion: 2,
	entries: [
		{
			family: 'gateway',
			name: 'hermes',
			fingerprint: gatewayFingerprint,
			recipeFingerprint: '3'.repeat(64),
		},
		{
			family: 'toolVm',
			name: 'default',
			fingerprint: toolFingerprint,
			recipeFingerprint: '4'.repeat(64),
		},
	],
};
export function sha256(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}
export const manifestBytes = Buffer.from(JSON.stringify(rawManifest));
function measuredImage(family: 'gateway' | 'toolVm'): CacheObservation['images'][number] {
	return {
		family,
		name: family === 'gateway' ? 'hermes' : 'default',
		metadata: {
			status: 'measured',
			fingerprint: family === 'gateway' ? gatewayFingerprint : toolFingerprint,
			manifestSha256: '5'.repeat(64),
			configurationSha256: '6'.repeat(64),
			declaredArchitecture: 'x86_64',
			declaredDistro: 'alpine',
			assets: (['kernel', 'initramfs', 'rootfs'] as const).map((role) => ({
				role,
				declaredSha256: '7'.repeat(64),
				bytes: { status: 'measured', sizeBytes: 3, sha256: '7'.repeat(64), checksumMatch: true },
			})),
		},
	};
}
export function observation(): CacheObservation {
	return {
		schemaVersion: 1,
		kind: 'prepared-e2e-image-cache-observation',
		provenance: {
			inputHash,
			preparationInputHash: inputHash,
			consumerPrimaryKey: 'agent-vm-e2e-images-v1-hermes-Linux-' + inputHash,
			consumerCacheHit: 'hit',
			preparationLookup: 'hit',
			experiment: 'retained-cache',
		},
		preparedManifest: { status: 'measured', sha256: sha256(manifestBytes) },
		images: [measuredImage('gateway'), measuredImage('toolVm')],
		gatewayToolKernel: 'equal',
	};
}
export function inputIo(bytes: Uint8Array = manifestBytes, unsafe = false): InspectionIo {
	return {
		async lstat(filePath) {
			return filePath.endsWith('.json')
				? {
						kind: unsafe ? 'symlink' : 'file',
						sizeBytes: bytes.byteLength,
						identity: 'fixture-manifest',
					}
				: { kind: 'directory', sizeBytes: 0, identity: 'fixture-directory' };
		},
		async realpath(filePath) {
			return filePath;
		},
		async *readChunks() {
			yield bytes;
		},
	};
}
function statBytes(pid: number): Uint8Array {
	const fields = Array.from({ length: 20 }, () => '0');
	fields[0] = 'S';
	fields[1] = '1234';
	fields[19] = '987654321';
	return Buffer.from(String(pid) + ' (qemu fixture) ' + fields.join(' ') + '\n');
}
interface FakeVmBehavior {
	readonly startError?: Error;
	readonly closeError?: Error;
	readonly createError?: Error;
	readonly stillAlive?: boolean;
	readonly exitUnknown?: boolean;
	readonly noPublicPid?: boolean;
	readonly noConsole?: boolean;
	readonly cmdlineUnavailable?: boolean;
	readonly teardownAfterRejection?: boolean;
	readonly loseFallbackCapture?: boolean;
	readonly closeOnlyConsole?: boolean;
}
export function fixture(
	behaviors: readonly FakeVmBehavior[] = [{}],
	before: CacheObservation = observation(),
): {
	readonly dependencies: ProbeDependencies;
	readonly events: string[];
	readonly options: ProbeVmOptions[];
	readonly hookOptions: unknown[];
	readonly procReads: string[];
	readonly states: { alive: boolean; publicPid: number | null }[];
} {
	const events: string[] = [];
	const options: ProbeVmOptions[] = [];
	const hookOptions: unknown[] = [];
	const procReads: string[] = [];
	const states: { alive: boolean; publicPid: number | null }[] = [];
	const captureFinished: (() => void)[] = [];
	let count = 0;
	let elapsed = 0;
	const processIo: OwnedProcessIo = {
		platform: 'linux',
		ownerPid: 1234,
		async realpath(filePath) {
			return filePath;
		},
		async readBounded(filePath) {
			procReads.push(filePath);
			const match = /^\/proc\/(\d+)\/(stat|cmdline)$/u.exec(filePath);
			if (match === null) throw new Error('fixture unexpected process read');
			const index = Number(match[1]) - 50;
			const state = states[index];
			const behavior = behaviors[index] ?? {};
			if (state === undefined) throw new Error('fixture missing own process');
			if (behavior.loseFallbackCapture && filePath.endsWith('/stat')) {
				await new Promise<void>((resolve) => {
					setTimeout(resolve, 0);
				});
			}
			if (!state.alive) {
				if (behavior.exitUnknown) throw new ProcessReadFailure('read-failed');
				throw new ProcessReadFailure('missing');
			}
			if (filePath.endsWith('/stat')) return statBytes(index + 50);
			if (behavior.cmdlineUnavailable) throw new ProcessReadFailure('read-failed');
			const selectedOptions = options[index];
			if (selectedOptions === undefined) throw new Error('fixture missing selected image');
			const selected = selectedOptions.sandbox.imagePath;
			return Buffer.from(
				[
					'/usr/bin/qemu-system-x86_64',
					'-m',
					selectedOptions.memory,
					'-accel',
					'kvm',
					'-machine',
					'microvm',
					'-cpu',
					'host',
					'-serial',
					'stdio',
					'-kernel',
					selected + '/vmlinuz-virt',
					'-initrd',
					selected + '/initramfs.cpio.lz4',
					'-append',
					'console=ttyS0',
				].join('\0') + '\0',
			);
		},
	};
	const sdk: PublicProbeSdk = {
		createHttpHooks(hooks) {
			hookOptions.push(hooks);
			return { env: {}, httpHooks: {} };
		},
		VM: {
			async create(createOptions) {
				const index = count;
				count += 1;
				const behavior = behaviors[index] ?? {};
				options.push(createOptions);
				events.push('create:' + String(index));
				if (behavior.createError !== undefined) throw behavior.createError;
				const state = { alive: false, publicPid: null as number | null };
				states[index] = state;
				let captured = false;
				let teardownPromise: Promise<void> | undefined;
				const capturedPromise = new Promise<void>((resolve) => {
					captureFinished[index] = resolve;
				});
				return {
					...(behavior.noPublicPid
						? {}
						: {
								getHostPid(): number | null {
									// The second public read is capture's final race check, after both stat reads.
									if (state.publicPid !== null && captured) captureFinished[index]?.();
									captured = state.publicPid !== null;
									return state.publicPid;
								},
							}),
					async start() {
						events.push('start:' + String(index));
						state.alive = true;
						state.publicPid = index + 50;
						if (!behavior.noConsole && !behavior.closeOnlyConsole) {
							createOptions.debugLog(
								'qemu',
								'stdout: [    1.250] Linux version fixture-private-banner',
							);
						}
						if (behavior.teardownAfterRejection) {
							if (!behavior.noConsole) await capturedPromise;
							teardownPromise = new Promise<void>((resolve) => {
								setTimeout(() => {
									state.publicPid = null;
									state.alive = false;
									events.push('sdk-teardown');
									resolve();
								}, 0);
							});
						}
						if (behavior.startError !== undefined) throw behavior.startError;
					},
					async close() {
						events.push('close:' + String(index));
						if (teardownPromise !== undefined) await teardownPromise;
						createOptions.debugLog('qemu', 'stdout: trailing fixture-private-console-text');
						if (!behavior.stillAlive) {
							state.alive = false;
							state.publicPid = null;
						}
						if (behavior.closeError !== undefined) throw behavior.closeError;
					},
				};
			},
		},
	};
	return {
		events,
		options,
		hookOptions,
		procReads,
		states,
		dependencies: {
			sdk,
			processIo,
			inputIo: inputIo(),
			inspect: async () => before,
			cacheRoot,
			now: () => {
				elapsed += 100;
				return elapsed;
			},
			environment: {},
		},
	};
}
export async function firstInput(
	data: ReturnType<typeof fixture>,
): Promise<Parameters<typeof probeOneImage>[0]['input']> {
	const inputs = await selectBootProbeInputs({
		observation: await data.dependencies.inspect(),
		cacheRoot,
		io: data.dependencies.inputIo,
		environment: {},
	});
	if (inputs.status !== 'available') throw new Error('fixture input unavailable');
	return inputs.images[0];
}
export function rewriteMetadata(
	before: CacheObservation,
	rewrite: (
		metadata: Extract<
			CacheObservation['images'][number]['metadata'],
			{ readonly status: 'measured' }
		>,
	) => CacheObservation['images'][number]['metadata'],
): CacheObservation {
	return {
		...before,
		images: before.images.map((image) => ({
			...image,
			metadata: image.metadata.status === 'measured' ? rewrite(image.metadata) : image.metadata,
		})),
	};
}
