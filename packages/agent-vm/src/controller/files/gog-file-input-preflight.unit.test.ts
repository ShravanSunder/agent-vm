import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { inspectGogFileInputs } from './gog-file-input-preflight.js';

describe('Gog approval-bound file inputs', () => {
	it('hashes each normalized source once without retaining payloads or consulting terminal cwd', async () => {
		// Arrange
		const bytes = new Uint8Array([0, 255, 13, 128]);
		const read = vi.fn(async function* (_relativePath: string) {
			yield bytes.subarray(0, 2);
			yield bytes.subarray(2);
		});
		const binding = { leaseId: 'lease', leafGeneration: 'generation', vmId: 'vm' };
		// Act
		const snapshot = await inspectGogFileInputs({
			binding,
			paths: ['./report.pdf', 'report.pdf', 'reports/input.pdf'],
			files: { read },
			signal: new AbortController().signal,
		});
		// Assert
		expect(read.mock.calls).toEqual([['report.pdf'], ['reports/input.pdf']]);
		expect(snapshot).toEqual({
			...binding,
			files: ['report.pdf', 'reports/input.pdf'].map((relativePath) => ({
				relativePath,
				byteLength: 4,
				sha256: createHash('sha256').update(bytes).digest('hex'),
			})),
		});
		expect(JSON.stringify(snapshot)).not.toContain('content');
	});

	it('rejects unsupported paths before reading any input', async () => {
		// Arrange
		const read = vi.fn(async function* () {
			yield new Uint8Array();
		});
		// Act / Assert
		await expect(
			inspectGogFileInputs({
				binding: { leaseId: 'lease', leafGeneration: 'generation', vmId: 'vm' },
				paths: ['valid.pdf', '../other'],
				files: { read },
				signal: new AbortController().signal,
			}),
		).rejects.toThrow('invalid-path');
		expect(read).not.toHaveBeenCalled();
	});
});
