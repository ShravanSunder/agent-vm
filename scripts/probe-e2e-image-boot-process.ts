/// <reference types="node" />
/// <reference lib="es2024" />
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

export const processReadLimits = { stat: 4096, cmdline: 64 * 1024, arguments: 256 } as const;
export interface OwnedProcessIo {
	readonly platform: string;
	readonly ownerPid: number;
	readBounded(filePath: string, maxBytes: number): Promise<Uint8Array>;
	realpath(filePath: string): Promise<string>;
}
export interface OwnedProcessIdentity {
	readonly pid: number;
	readonly parentPid: number;
	readonly startTime: string;
}
type ProcessUnavailable =
	| 'unsupported'
	| 'missing'
	| 'read-failed'
	| 'malformed'
	| 'over-limit'
	| 'changed';
export type ProcessObservation =
	| { readonly status: ProcessUnavailable }
	| {
			readonly status: 'observed';
			readonly memory: '1G' | '2G' | 'other';
			readonly accelerator: 'kvm' | 'tcg' | 'hvf' | 'other';
			readonly machine: 'microvm' | 'q35' | 'virt' | 'other';
			readonly cpu: 'host' | 'max' | 'other';
			readonly serial: 'stdio' | 'none' | 'other';
			readonly console: 'ttyS0' | 'ttyAMA0' | 'hvc0' | 'other' | 'absent';
			readonly kernelMatchesSelectedAsset: boolean | null;
			readonly initrdMatchesSelectedAsset: boolean | null;
			readonly qemuExecutable: 'qemu-system-x86_64' | 'qemu-system-aarch64' | 'other';
	  };
export interface OwnedProcessCapture {
	readonly observation: ProcessObservation;
	readonly identity: OwnedProcessIdentity | null;
}
export class ProcessReadFailure extends Error {
	readonly status: ProcessUnavailable;
	constructor(status: ProcessUnavailable) {
		super(status);
		this.name = 'ProcessReadFailure';
		this.status = status;
	}
}
function decodeBounded(bytes: Uint8Array, maxBytes: number): string {
	if (bytes.byteLength > maxBytes) throw new ProcessReadFailure('over-limit');
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		throw new ProcessReadFailure('malformed');
	}
}
export function parseOwnedProcessStat(bytes: Uint8Array): OwnedProcessIdentity {
	const text = decodeBounded(bytes, processReadLimits.stat);
	const start = text.indexOf(' (');
	const end = text.lastIndexOf(') ');
	if (start < 1 || end <= start) throw new ProcessReadFailure('malformed');
	const pid = Number(text.slice(0, start));
	const fields = text
		.slice(end + 2)
		.trim()
		.split(/\s+/u);
	const parentPid = Number(fields[1]);
	const startTime = fields[19];
	if (
		!Number.isSafeInteger(pid) ||
		pid <= 0 ||
		!Number.isSafeInteger(parentPid) ||
		parentPid <= 0 ||
		startTime === undefined ||
		!/^\d{1,20}$/u.test(startTime)
	)
		throw new ProcessReadFailure('malformed');
	return { pid, parentPid, startTime };
}
function sameIncarnation(left: OwnedProcessIdentity, right: OwnedProcessIdentity): boolean {
	return left.pid === right.pid && left.startTime === right.startTime;
}
function flagValue(argumentsList: readonly string[], name: string): string | undefined {
	const indices = argumentsList.flatMap((value, index) => (value === name ? [index] : []));
	if (indices.length > 1) throw new ProcessReadFailure('malformed');
	const index = indices[0];
	if (index === undefined) return undefined;
	const value = argumentsList[index + 1];
	if (value === undefined || value.startsWith('-')) throw new ProcessReadFailure('malformed');
	return value;
}
async function projectArguments(props: {
	readonly bytes: Uint8Array;
	readonly io: OwnedProcessIo;
	readonly selectedKernel: string;
	readonly selectedInitrd: string;
}): Promise<Extract<ProcessObservation, { readonly status: 'observed' }>> {
	const text = decodeBounded(props.bytes, processReadLimits.cmdline);
	if (!text.endsWith('\0')) throw new ProcessReadFailure('malformed');
	const argumentsList = text.split('\0', processReadLimits.arguments + 2);
	if (argumentsList.length > processReadLimits.arguments + 1)
		throw new ProcessReadFailure('over-limit');
	argumentsList.pop();
	if (argumentsList.length === 0 || argumentsList.some((value) => value.length > 8192))
		throw new ProcessReadFailure('malformed');
	const memory = flagValue(argumentsList, '-m');
	const accelerator = flagValue(argumentsList, '-accel')?.split(',')[0];
	const machine = flagValue(argumentsList, '-machine')?.split(',')[0];
	const cpu = flagValue(argumentsList, '-cpu')?.split(',')[0];
	const serial = flagValue(argumentsList, '-serial');
	const append = flagValue(argumentsList, '-append');
	const consoles = append?.split(/\s+/u).filter((token) => token.startsWith('console=')) ?? [];
	const consoleToken = consoles.length === 1 ? consoles[0]?.slice(8).split(',')[0] : undefined;
	const kernel = flagValue(argumentsList, '-kernel');
	const initrd = flagValue(argumentsList, '-initrd');
	const kernelMatchesSelectedAsset =
		kernel === undefined
			? null
			: (await props.io.realpath(kernel)) === (await props.io.realpath(props.selectedKernel));
	const initrdMatchesSelectedAsset =
		initrd === undefined
			? null
			: (await props.io.realpath(initrd)) === (await props.io.realpath(props.selectedInitrd));
	const executable = path.basename(argumentsList[0] ?? '');
	return {
		status: 'observed',
		memory: memory === '1G' || memory === '2G' ? memory : 'other',
		accelerator:
			accelerator === 'kvm' || accelerator === 'tcg' || accelerator === 'hvf'
				? accelerator
				: 'other',
		machine: machine === 'microvm' || machine === 'q35' || machine === 'virt' ? machine : 'other',
		cpu: cpu === 'host' || cpu === 'max' ? cpu : 'other',
		serial: serial === 'stdio' || serial === 'none' ? serial : 'other',
		console:
			consoles.length === 0
				? 'absent'
				: consoleToken === 'ttyS0' || consoleToken === 'ttyAMA0' || consoleToken === 'hvc0'
					? consoleToken
					: 'other',
		kernelMatchesSelectedAsset,
		initrdMatchesSelectedAsset,
		qemuExecutable:
			executable === 'qemu-system-x86_64' || executable === 'qemu-system-aarch64'
				? executable
				: 'other',
	};
}
export async function captureOwnedProcess(props: {
	readonly io: OwnedProcessIo;
	readonly pid: number;
	readonly getHostPid: () => number | null;
	readonly selectedKernel: string;
	readonly selectedInitrd: string;
}): Promise<OwnedProcessCapture> {
	if (props.io.platform !== 'linux')
		return { observation: { status: 'unsupported' }, identity: null };
	if (!Number.isSafeInteger(props.pid) || props.pid <= 0)
		return { observation: { status: 'missing' }, identity: null };
	const statPath = path.join('/proc', String(props.pid), 'stat');
	try {
		const before = parseOwnedProcessStat(
			await props.io.readBounded(statPath, processReadLimits.stat),
		);
		if (before.pid !== props.pid || before.parentPid !== props.io.ownerPid)
			throw new ProcessReadFailure('changed');
		let observation: ProcessObservation;
		try {
			const bytes = await props.io.readBounded(
				path.join('/proc', String(props.pid), 'cmdline'),
				processReadLimits.cmdline,
			);
			observation = await projectArguments({
				bytes,
				io: props.io,
				selectedKernel: props.selectedKernel,
				selectedInitrd: props.selectedInitrd,
			});
		} catch (error) {
			observation = { status: error instanceof ProcessReadFailure ? error.status : 'read-failed' };
		}
		const after = parseOwnedProcessStat(
			await props.io.readBounded(statPath, processReadLimits.stat),
		);
		if (
			!sameIncarnation(before, after) ||
			after.parentPid !== props.io.ownerPid ||
			props.getHostPid() !== props.pid
		)
			throw new ProcessReadFailure('changed');
		return { observation, identity: before };
	} catch (error) {
		return {
			observation: { status: error instanceof ProcessReadFailure ? error.status : 'read-failed' },
			identity: null,
		};
	}
}
export async function observeOwnedRunnerExit(
	identity: OwnedProcessIdentity | null,
	io: OwnedProcessIo,
): Promise<'exited' | 'still-observed' | 'unknown'> {
	if (identity === null || io.platform !== 'linux') return 'unknown';
	try {
		const after = parseOwnedProcessStat(
			await io.readBounded(
				path.join('/proc', String(identity.pid), 'stat'),
				processReadLimits.stat,
			),
		);
		return sameIncarnation(identity, after) ? 'still-observed' : 'exited';
	} catch (error) {
		return error instanceof ProcessReadFailure && error.status === 'missing' ? 'exited' : 'unknown';
	}
}
export const osOwnedProcessIo: OwnedProcessIo = {
	platform: process.platform,
	ownerPid: process.pid,
	async realpath(filePath) {
		return await realpath(filePath);
	},
	async readBounded(filePath, maxBytes) {
		try {
			const handle = await open(
				filePath,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			try {
				const chunks: Uint8Array[] = [];
				let total = 0;
				while (total <= maxBytes) {
					const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
					// oxlint-disable-next-line no-await-in-loop -- bounded sequential proc reads cannot be parallelized.
					const read = await handle.read(buffer, 0, buffer.byteLength, null);
					if (read.bytesRead === 0) break;
					chunks.push(buffer.subarray(0, read.bytesRead));
					total += read.bytesRead;
				}
				if (total > maxBytes) throw new ProcessReadFailure('over-limit');
				return Buffer.concat(chunks);
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (error instanceof ProcessReadFailure) throw error;
			const code =
				typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
			throw new ProcessReadFailure(
				code === 'ENOENT' || code === 'ESRCH' ? 'missing' : 'read-failed',
			);
		}
	},
};
