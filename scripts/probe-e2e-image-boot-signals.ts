/// <reference types="node" />
/// <reference lib="es2024" />
import {
	createManagedVmBootSignalTracker,
	type ManagedVmBootSignalSnapshot,
} from '../packages/gondolin-vm-adapter/src/managed-vm-boot-diagnostics.ts';

export const bootSignalLimits = {
	lines: 4096,
	messageCharacters: 8192,
	kernelDeciseconds: 36000,
} as const;
type StdoutLineClass = 'none' | 'timestamped' | 'untimestamped';
export interface ProbeBootSignals {
	readonly stdoutLineCount: number;
	readonly stdoutLineCountCapped: boolean;
	readonly kernelTimestampedLineCount: number;
	readonly maxKernelTimestampDeciseconds: number;
	readonly invalidTimestampObserved: boolean;
	readonly oversizedMessageObserved: boolean;
	readonly firstStdoutLineClass: StdoutLineClass;
	readonly lastStdoutLineClass: StdoutLineClass;
	readonly linuxVersionAnywhereObserved: boolean;
	readonly firmware: {
		readonly seaBios: boolean;
		readonly ipxe: boolean;
		readonly bootingRom: boolean;
	};
	readonly lastStdoutAge: 'none' | 'less5' | 'less30' | 'less90' | 'atLeast90';
	readonly existing: ManagedVmBootSignalSnapshot;
}
export interface ProbeSignalTracker {
	observe(component: unknown, message: unknown): void;
	snapshot(): ProbeBootSignals;
	stop(): void;
}
export function createProbeBootSignalTracker(now: () => number): ProbeSignalTracker {
	const existing = createManagedVmBootSignalTracker();
	let active = true;
	let stdoutLineCount = 0;
	let stdoutLineCountCapped = false;
	let kernelTimestampedLineCount = 0;
	let maxKernelTimestampDeciseconds = 0;
	let invalidTimestampObserved = false;
	let oversizedMessageObserved = false;
	let firstStdoutLineClass: StdoutLineClass = 'none';
	let lastStdoutLineClass: StdoutLineClass = 'none';
	let linuxVersionAnywhereObserved = false;
	let seaBios = false;
	let ipxe = false;
	let bootingRom = false;
	let lastStdoutAt: number | undefined;
	function ageBucket(): ProbeBootSignals['lastStdoutAge'] {
		const current = now();
		if (lastStdoutAt === undefined || !Number.isFinite(current) || current < lastStdoutAt)
			return 'none';
		const elapsed = current - lastStdoutAt;
		return elapsed < 5000
			? 'less5'
			: elapsed < 30000
				? 'less30'
				: elapsed < 90000
					? 'less90'
					: 'atLeast90';
	}
	return {
		observe(component, message): void {
			if (!active || typeof component !== 'string' || typeof message !== 'string') return;
			const stdout = component === 'qemu' && message.startsWith('stdout: ') && message.length > 8;
			if (stdout) {
				const observedAt = now();
				lastStdoutAt = Number.isFinite(observedAt) ? observedAt : undefined;
				if (stdoutLineCount < bootSignalLimits.lines) stdoutLineCount += 1;
				else stdoutLineCountCapped = true;
			}
			if (message.length > bootSignalLimits.messageCharacters) {
				oversizedMessageObserved = true;
				return;
			}
			existing.observe(component, message);
			if (!stdout) return;
			const text = message.slice(8);
			const timestamp = /^\[\s*(\d{1,10})(?:\.(\d{1,9}))?\]\s+/u.exec(text);
			lastStdoutLineClass = timestamp === null ? 'untimestamped' : 'timestamped';
			if (firstStdoutLineClass === 'none') firstStdoutLineClass = lastStdoutLineClass;
			if (timestamp !== null) {
				kernelTimestampedLineCount = Math.min(
					kernelTimestampedLineCount + 1,
					bootSignalLimits.lines,
				);
				const seconds = Number(timestamp[1] + '.' + (timestamp[2] ?? '0'));
				maxKernelTimestampDeciseconds = Math.max(
					maxKernelTimestampDeciseconds,
					Math.min(Math.round(seconds * 10), bootSignalLimits.kernelDeciseconds),
				);
			} else if (/^\[\s*[\d.+-]/u.test(text)) invalidTimestampObserved = true;
			linuxVersionAnywhereObserved ||= text.includes('Linux version ');
			seaBios ||= text.includes('SeaBIOS');
			ipxe ||= text.includes('iPXE');
			bootingRom ||= text.includes('Booting from ROM');
		},
		snapshot(): ProbeBootSignals {
			return {
				stdoutLineCount,
				stdoutLineCountCapped,
				kernelTimestampedLineCount,
				maxKernelTimestampDeciseconds,
				invalidTimestampObserved,
				oversizedMessageObserved,
				firstStdoutLineClass,
				lastStdoutLineClass,
				linuxVersionAnywhereObserved,
				firmware: { seaBios, ipxe, bootingRom },
				lastStdoutAge: ageBucket(),
				existing: existing.snapshot(),
			};
		},
		stop(): void {
			active = false;
			existing.stop();
		},
	};
}
