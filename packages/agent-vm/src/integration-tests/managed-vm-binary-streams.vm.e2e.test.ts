import type { ManagedVm, ManagedVmExecResult } from '@agent-vm/managed-vm';
import { describe, expect, it } from 'vitest';

import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';
import { startManagedGatewayImageBootFixture } from './managed-gateway-image-boot-test-fixture.js';

const describeLiveBinaryStreams = shouldRunLiveVmE2e() ? describe : describe.skip;

// Binary data crosses the real guest process and the neutral ManagedVm wrapper.
// This deliberately does not exercise the configured-CLI text result projector.
// V9 explicitly excludes bulk stdin duplex. Prove the admitted output path,
// including empty output, without depending on the experimental guest duplex fix.
const binaryOutputScript = [
	'import sys',
	'length = int(sys.argv[1])',
	'for offset in range(0, length, 4096):',
	'    chunk = bytes(index % 256 for index in range(offset, min(offset + 4096, length)))',
	'    sys.stdout.buffer.write(chunk)',
	'    sys.stdout.buffer.flush()',
	'    sys.stderr.buffer.write(bytes(value ^ 255 for value in chunk))',
	'    sys.stderr.buffer.flush()',
].join('\n');

async function captureBinaryOutput(props: {
	readonly byteLength: number;
	readonly vm: ManagedVm;
}): Promise<{
	readonly result: ManagedVmExecResult;
	readonly stderr: Buffer;
	readonly stdout: Buffer;
}> {
	const process = props.vm.exec(
		['/opt/hermes/.venv/bin/python', '-c', binaryOutputScript, String(props.byteLength)],
		{
			output: {
				stderr: { kind: 'pipe' },
				stdout: { kind: 'pipe' },
				windowBytes: 4_096,
			},
			pty: false,
			signal: AbortSignal.timeout(30_000),
		},
	);
	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	const capturedBytes = { stderr: 0, stdout: 0 };
	const drainOutput = async (): Promise<void> => {
		for await (const chunk of process.output()) {
			capturedBytes[chunk.stream] += chunk.data.byteLength;
			if (capturedBytes[chunk.stream] > props.byteLength + 4_096) {
				throw new Error('Binary stream proof exceeded its bounded capture size.');
			}
			const target = chunk.stream === 'stdout' ? stdoutChunks : stderrChunks;
			target.push(Buffer.from(chunk.data));
		}
	};
	try {
		const [result] = await Promise.all([process.result, drainOutput()]);
		return { result, stderr: Buffer.concat(stderrChunks), stdout: Buffer.concat(stdoutChunks) };
	} catch (error) {
		throw new Error(
			`Binary output failed: expected=${String(props.byteLength)}, stdout=${String(capturedBytes.stdout)}, stderr=${String(capturedBytes.stderr)} bytes.`,
			{ cause: error },
		);
	}
}

describeLiveBinaryStreams('real ManagedVm binary streams', () => {
	it('preserves output-only binary streams beyond the flow-control window', async () => {
		// Arrange: isolate output flow control from simultaneous stdin delivery.
		const fixture = await startManagedGatewayImageBootFixture({
			sessionLabel: 'managed-vm-binary-output-proof',
		});
		const expected = Buffer.from(
			Uint8Array.from({ length: 256 * 1_024 }, (_, index) => index % 256),
		);
		try {
			// Act: emit real binary output without relying on input EOF.
			const process = fixture.vm.exec(
				[
					'/opt/hermes/.venv/bin/python',
					'-c',
					'import sys; sys.stdout.buffer.write(bytes(range(256)) * 1024); sys.stderr.buffer.write(bytes(reversed(range(256))) * 1024)',
				],
				{
					output: {
						stderr: { kind: 'pipe' },
						stdout: { kind: 'pipe' },
						windowBytes: 4_096,
					},
					pty: false,
					signal: AbortSignal.timeout(30_000),
				},
			);
			const chunks: { stderr: Buffer[]; stdout: Buffer[] } = { stderr: [], stdout: [] };
			const counts = { stderr: 0, stdout: 0 };
			const drain = async (): Promise<void> => {
				for await (const chunk of process.output()) {
					counts[chunk.stream] += chunk.data.byteLength;
					if (counts[chunk.stream] > expected.byteLength + 4_096) {
						throw new Error('Output-only proof exceeded its bounded capture size.');
					}
					chunks[chunk.stream].push(Buffer.from(chunk.data));
				}
			};
			const [result] = await Promise.all([process.result, drain()]);

			// Assert: complete, separate streams; no lossy text projection.
			expect(result.exitCode).toBe(0);
			expect(Buffer.concat(chunks.stdout)).toEqual(expected);
			expect(Buffer.concat(chunks.stderr)).toEqual(
				Buffer.from(expected.map((value) => value ^ 255)),
			);
		} finally {
			await fixture.close();
		}
	});

	it('preserves all byte values and empty output across separate piped streams', async () => {
		// Arrange: the payload exceeds the 4 KiB output window by 64 times and
		// includes NUL, invalid UTF-8 and multibyte sequences split across chunks.
		const fixture = await startManagedGatewayImageBootFixture({
			sessionLabel: 'managed-vm-binary-stream-proof',
		});
		const input = Uint8Array.from({ length: 256 * 1_024 }, (_, index) => index % 256);
		try {
			// Act: real guest executions, no simulated process or output iterator.
			const [nonempty, empty] = await Promise.all([
				captureBinaryOutput({ byteLength: input.byteLength, vm: fixture.vm }),
				captureBinaryOutput({ byteLength: 0, vm: fixture.vm }),
			]);

			// Assert: no cross-stream ordering assumption; each stream is exact.
			expect(nonempty.result.exitCode).toBe(0);
			expect(nonempty.stdout).toEqual(Buffer.from(input));
			expect(nonempty.stderr).toEqual(Buffer.from(input.map((value) => value ^ 255)));
			expect(nonempty.result.stdoutBuffer.byteLength).toBe(0);
			expect(nonempty.result.stderrBuffer.byteLength).toBe(0);
			expect(empty.result.exitCode).toBe(0);
			expect(empty.stdout.byteLength).toBe(0);
			expect(empty.stderr.byteLength).toBe(0);
		} finally {
			// AbortSignal alone is not guest process containment in pinned Gondolin.
			await fixture.close();
		}
	});
});
