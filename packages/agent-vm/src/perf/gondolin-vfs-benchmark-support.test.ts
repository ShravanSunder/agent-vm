import { describe, expect, test } from 'vitest';

import {
	assertExpectedMountToken,
	formatDurationRange,
	summarizeBenchmarkSamples,
} from './gondolin-vfs-benchmark-support.js';

describe('gondolin-vfs-benchmark-support', () => {
	test('summarizes benchmark samples with median, min, and max', () => {
		const summary = summarizeBenchmarkSamples([
			{ largeWriteMs: 30, smallReadMs: 20, smallWriteMs: 10 },
			{ largeWriteMs: 90, smallReadMs: 80, smallWriteMs: 70 },
			{ largeWriteMs: 60, smallReadMs: 50, smallWriteMs: 40 },
		]);

		expect(summary).toEqual({
			largeWriteMs: 60,
			largeWriteMsMax: 90,
			largeWriteMsMin: 30,
			smallReadMs: 50,
			smallReadMsMax: 80,
			smallReadMsMin: 20,
			smallWriteMs: 40,
			smallWriteMsMax: 70,
			smallWriteMsMin: 10,
		});
	});

	test('summarizes even sample counts with the upper median', () => {
		const summary = summarizeBenchmarkSamples([
			{ largeWriteMs: 400, smallReadMs: 200, smallWriteMs: 20 },
			{ largeWriteMs: 100, smallReadMs: 100, smallWriteMs: 10 },
			{ largeWriteMs: 300, smallReadMs: 400, smallWriteMs: 40 },
			{ largeWriteMs: 200, smallReadMs: 300, smallWriteMs: 30 },
		]);

		expect(summary.smallWriteMs).toBe(30);
		expect(summary.smallReadMs).toBe(300);
		expect(summary.largeWriteMs).toBe(300);
	});

	test('rejects empty sample lists', () => {
		expect(() => summarizeBenchmarkSamples([])).toThrow('at least one sample');
	});

	test('formats a single-value duration range compactly', () => {
		expect(formatDurationRange({ median: 17.2, min: 17.2, max: 17.2 })).toBe('17ms');
	});

	test('formats duration ranges when samples vary', () => {
		expect(formatDurationRange({ median: 20.2, min: 10.4, max: 30.8 })).toBe(
			'20ms median [10-31ms]',
		);
	});

	test('accepts expected mount tokens', () => {
		expect(() =>
			assertExpectedMountToken({
				label: 'realfs',
				mountInfo: 'sandboxfs on /realfs type fuse.sandboxfs (rw,nosuid,nodev,relatime)',
				token: 'fuse.sandboxfs',
			}),
		).not.toThrow();
	});

	test('throws when the expected mount token is missing', () => {
		expect(() =>
			assertExpectedMountToken({
				label: 'realfs',
				mountInfo: '/dev/vda on /realfs type ext4 (rw,relatime)',
				token: 'fuse.sandboxfs',
			}),
		).toThrow("Expected mount for 'realfs' to include 'fuse.sandboxfs'");
	});
});
