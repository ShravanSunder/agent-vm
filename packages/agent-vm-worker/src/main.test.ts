import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleCliMainError, ReportedCliError, runAgentVmWorkerCli } from './main.js';

describe('agent-vm-worker cli', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('prints top-level help via cmd-ts', async () => {
		const stdoutChunks: string[] = [];

		await expect(
			runAgentVmWorkerCli(['--help'], {
				stdout: {
					write: (chunk: string | Uint8Array) => {
						stdoutChunks.push(String(chunk));
						return true;
					},
				},
				stderr: { write: () => true },
			}),
		).resolves.toBeUndefined();

		expect(stdoutChunks.join('')).toContain('agent-vm-worker');
		expect(stdoutChunks.join('')).toContain('serve');
		expect(stdoutChunks.join('')).toContain('health');
	});

	it('prints subcommand help via cmd-ts', async () => {
		const stdoutChunks: string[] = [];

		await expect(
			runAgentVmWorkerCli(['serve', '--help'], {
				stdout: {
					write: (chunk: string | Uint8Array) => {
						stdoutChunks.push(String(chunk));
						return true;
					},
				},
				stderr: { write: () => true },
			}),
		).resolves.toBeUndefined();

		expect(stdoutChunks.join('')).toContain('serve');
		expect(stdoutChunks.join('')).toContain('--port');
		expect(stdoutChunks.join('')).toContain('--config');
	});

	it('reports health check failures without hard process exit', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(null, { status: 503 }));
		const stderrChunks: string[] = [];

		await expect(
			runAgentVmWorkerCli(['health', '--port', '19999'], {
				stdout: { write: () => true },
				stderr: {
					write: (chunk: string | Uint8Array) => {
						stderrChunks.push(String(chunk));
						return true;
					},
				},
			}),
		).rejects.toThrow('Health check failed: Health check failed: 503');

		expect(fetchMock).toHaveBeenCalledWith('http://localhost:19999/health');
		expect(stderrChunks).toHaveLength(0);
	});

	it('suppresses duplicate output for reported cli errors', () => {
		const stderrChunks: string[] = [];

		handleCliMainError(new ReportedCliError('already reported'), {
			write: (chunk: string | Uint8Array) => {
				stderrChunks.push(String(chunk));
				return true;
			},
		});

		expect(stderrChunks).toHaveLength(0);
	});

	it('writes unexpected errors in the main error handler', () => {
		const stderrChunks: string[] = [];

		handleCliMainError(new Error('boom'), {
			write: (chunk: string | Uint8Array) => {
				stderrChunks.push(String(chunk));
				return true;
			},
		});

		expect(stderrChunks.join('')).toContain('boom');
	});
});
