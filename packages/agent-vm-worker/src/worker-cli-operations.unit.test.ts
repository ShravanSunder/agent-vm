import { afterEach, describe, expect, it, vi } from 'vitest';

import { runWorkerHealthOperation } from './worker-cli-operations.js';

describe('worker CLI operations', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('writes the existing health response JSON to stdout', async () => {
		const requestedUrls: string[] = [];
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			requestedUrls.push(
				typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
			);
			return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
		});
		const stdoutChunks: string[] = [];

		await runWorkerHealthOperation(
			{ command: 'health', port: 18_789 },
			{
				stdout: {
					write: (chunk: string | Uint8Array) => {
						stdoutChunks.push(String(chunk));
						return true;
					},
				},
			},
		);

		expect(requestedUrls).toEqual(['http://localhost:18789/health']);
		expect(stdoutChunks.join('')).toBe('{\n  "status": "ok"\n}\n');
	});

	it('preserves the health failure classification', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));

		await expect(
			runWorkerHealthOperation(
				{ command: 'health', port: 19_999 },
				{ stdout: { write: () => true } },
			),
		).rejects.toThrow('Health check failed: HTTP 503');
	});
});
