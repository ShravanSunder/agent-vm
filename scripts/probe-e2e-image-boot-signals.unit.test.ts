import { describe, expect, it } from 'vitest';

import { bootSignalLimits, createProbeBootSignalTracker } from './probe-e2e-image-boot-signals.ts';

describe('closed boot console projection', () => {
	it('counts delivered lines and reuses the original managed signal classifier', () => {
		const tracker = createProbeBootSignalTracker(() => 0);
		tracker.observe('qemu', 'stdout: [    3.140] Linux version fixture');
		tracker.observe('qemu', 'stdout: [    3.200] Run /init as init process');
		tracker.observe('protocol', 'virtio rx t=exec_response id=3 exit=0');
		tracker.observe('protocol', 'virtiofs rx t=stat id=4');
		const result = tracker.snapshot();
		expect(result).toMatchObject({
			stdoutLineCount: 2,
			kernelTimestampedLineCount: 2,
			maxKernelTimestampDeciseconds: 32,
			firstStdoutLineClass: 'timestamped',
			lastStdoutLineClass: 'timestamped',
			linuxVersionAnywhereObserved: true,
			lastStdoutAge: 'less5',
			existing: {
				linuxKernelBannerObserved: true,
				initProcessLaunchObserved: true,
				guestControlFrameCount: 1,
				execResponseCount: 1,
				virtioFsFrameCount: 1,
			},
		});
	});
	it('finds a banner anywhere without changing the old prefix classifier', () => {
		const tracker = createProbeBootSignalTracker(() => 0);
		tracker.observe('qemu', 'stdout: prefix Linux version fixture-private-text');
		expect(tracker.snapshot()).toMatchObject({
			linuxVersionAnywhereObserved: true,
			firstStdoutLineClass: 'untimestamped',
			existing: { linuxKernelBannerObserved: false },
		});
	});
	it('projects fixed firmware matches and preserves first versus last line class', () => {
		const tracker = createProbeBootSignalTracker(() => 0);
		tracker.observe('qemu', 'stdout: SeaBIOS fixture-private-firmware');
		tracker.observe('qemu', 'stdout: iPXE Booting from ROM');
		tracker.observe('qemu', 'stdout: [1.2] unclassified');
		expect(tracker.snapshot()).toMatchObject({
			firmware: { seaBios: true, ipxe: true, bootingRom: true },
			firstStdoutLineClass: 'untimestamped',
			lastStdoutLineClass: 'timestamped',
		});
	});
	it('caps counters and kernel deciseconds without retaining delivered text', () => {
		const tracker = createProbeBootSignalTracker(() => 0);
		for (let index = 0; index < 4100; index += 1)
			tracker.observe('qemu', 'stdout: [9999999999.9] fixture-private-line');
		expect(tracker.snapshot()).toMatchObject({
			stdoutLineCount: 4096,
			stdoutLineCountCapped: true,
			kernelTimestampedLineCount: 4096,
			maxKernelTimestampDeciseconds: 36000,
		});
	});
	it('closes malformed timestamps and oversized input without numeric overflow or text leakage', () => {
		const tracker = createProbeBootSignalTracker(() => 0);
		tracker.observe('qemu', 'stdout: [99999999999999999999.999] fixture-private');
		tracker.observe('qemu', 'stdout: ' + 'x'.repeat(bootSignalLimits.messageCharacters));
		tracker.observe(null, { secret: 'fixture-private' });
		expect(tracker.snapshot()).toMatchObject({
			invalidTimestampObserved: true,
			oversizedMessageObserved: true,
			maxKernelTimestampDeciseconds: 0,
			kernelTimestampedLineCount: 0,
		});
		expect(JSON.stringify(tracker.snapshot())).not.toContain('fixture-private');
		expect(JSON.stringify(tracker.snapshot())).not.toContain('xxxx');
	});
	it.each([
		[0, 'less5'],
		[4999, 'less5'],
		[5000, 'less30'],
		[30000, 'less90'],
		[90000, 'atLeast90'],
	] as const)('buckets monotonic last-line age %s as %s', (elapsed, expected) => {
		let now = 0;
		const tracker = createProbeBootSignalTracker(() => now);
		tracker.observe('qemu', 'stdout: fixture');
		now = elapsed;
		expect(tracker.snapshot().lastStdoutAge).toBe(expected);
	});
	it('keeps missing and invalid clock observations unknown and stops late callbacks', () => {
		let now = 0;
		const tracker = createProbeBootSignalTracker(() => now);
		expect(tracker.snapshot().lastStdoutAge).toBe('none');
		tracker.observe('qemu', 'stdout: fixture');
		now = -1;
		expect(tracker.snapshot().lastStdoutAge).toBe('none');
		tracker.stop();
		tracker.observe('qemu', 'stdout: Kernel panic - not syncing: fixture');
		expect(tracker.snapshot()).toMatchObject({
			stdoutLineCount: 1,
			existing: { kernelPanicObserved: false },
		});
	});
	it('never emits untrusted serial, paths, credentials or free-form component names', () => {
		const tracker = createProbeBootSignalTracker(() => 0);
		tracker.observe(
			'qemu',
			'stdout: Bearer fixture-private-token /private/secret-path command=private-command',
		);
		tracker.observe('fixture-private-component', 'fixture-private-error');
		const output = JSON.stringify(tracker.snapshot());
		for (const value of ['Bearer', 'fixture-private', 'secret-path', 'private-command'])
			expect(output).not.toContain(value);
	});
});
