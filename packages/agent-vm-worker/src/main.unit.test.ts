import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	handleCliMainError,
	isCliEntrypoint,
	ReportedCliError,
	runAgentVmWorkerCli,
	type CliIo,
	type WorkerCliOperations,
} from './main.js';
import { runOptiqueCliParser } from './optique-cli-support.js';
import { resolveWorkerServePaths } from './worker-cli-operations.js';
import { createWorkerCommandParser, type WorkerCommand } from './worker-command-parser.js';

function createSilentIo(): CliIo {
	return {
		stderr: { write: () => true },
		stdout: { write: () => true },
	};
}

function parseWorkerCommand(argv: readonly string[]): WorkerCommand {
	const result = runOptiqueCliParser({
		argv,
		io: createSilentIo(),
		parser: createWorkerCommandParser(),
		programName: 'agent-vm-worker',
	});
	if (result.kind !== 'parsed') {
		throw new Error(`Expected parsed command, received ${result.kind}.`);
	}
	return result.value;
}

describe('agent-vm-worker cli', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('parses serve and health into strict discriminated command values', () => {
		expect(parseWorkerCommand(['serve'])).toEqual({
			command: 'serve',
			options: { config: undefined, port: 18_789, stateDir: undefined },
		});
		expect(
			parseWorkerCommand([
				'serve',
				'--port',
				'19123',
				'--config',
				'config/worker.json',
				'--state-dir',
				'/tmp/worker-state',
			]),
		).toEqual({
			command: 'serve',
			options: {
				config: 'config/worker.json',
				port: 19_123,
				stateDir: '/tmp/worker-state',
			},
		});
		expect(parseWorkerCommand(['health', '-p', '19123'])).toEqual({
			command: 'health',
			options: { port: 19_123 },
		});
		expect(parseWorkerCommand(['health', '--port', '0'])).toEqual({
			command: 'health',
			options: { port: 0 },
		});
	});

	it('resolves serve config fallback and state-directory truthiness without normalization', () => {
		expect(
			resolveWorkerServePaths({
				configPathFromCli: undefined,
				configPathFromEnvironment: '/env/worker.json',
				stateDirectoryFromCli: undefined,
			}),
		).toEqual({ configPath: '/env/worker.json', stateDirectoryOverride: undefined });
		expect(
			resolveWorkerServePaths({
				configPathFromCli: '',
				configPathFromEnvironment: '/env/worker.json',
				stateDirectoryFromCli: '',
			}),
		).toEqual({ configPath: '', stateDirectoryOverride: undefined });
		expect(
			resolveWorkerServePaths({
				configPathFromCli: undefined,
				configPathFromEnvironment: undefined,
				stateDirectoryFromCli: '/tmp/worker-state',
			}),
		).toEqual({ configPath: undefined, stateDirectoryOverride: '/tmp/worker-state' });
	});

	it('preserves empty string config and state-dir values for existing fallback and skip semantics', async () => {
		expect(parseWorkerCommand(['serve', '--config', ''])).toEqual({
			command: 'serve',
			options: { config: '', port: 18_789, stateDir: undefined },
		});
		expect(parseWorkerCommand(['serve', '--state-dir', ''])).toEqual({
			command: 'serve',
			options: { config: undefined, port: 18_789, stateDir: '' },
		});

		const receivedOptions: Array<WorkerCommand['options']> = [];
		const operations: WorkerCliOperations = {
			runHealth: async (): Promise<void> => undefined,
			runServe: async (options): Promise<void> => {
				receivedOptions.push(options);
			},
		};
		await runAgentVmWorkerCli(
			['serve', '--config', '', '--state-dir', ''],
			createSilentIo(),
			operations,
		);

		expect(receivedOptions).toEqual([{ config: '', port: 18_789, stateDir: '' }]);
	});

	it('rejects invalid worker ports during parsing', () => {
		for (const argv of [
			['health', '--port', '-1'],
			['health', '--port', '65536'],
			['health', '--port', '1.5'],
		] as const) {
			const result = runOptiqueCliParser({
				argv,
				io: createSilentIo(),
				parser: createWorkerCommandParser(),
				programName: 'agent-vm-worker',
			});
			expect(result, argv.join(' ')).toMatchObject({ kind: 'parse-error', exitCode: 1 });
		}
	});

	it('resolves symlinked executable paths asynchronously', async () => {
		const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'agent-vm-worker-cli-'));
		const realEntrypointPath = path.join(temporaryDirectory, 'worker.js');
		const symlinkEntrypointPath = path.join(temporaryDirectory, 'agent-vm-worker');
		await writeFile(realEntrypointPath, '');
		await symlink(realEntrypointPath, symlinkEntrypointPath);

		try {
			await expect(
				isCliEntrypoint(pathToFileURL(realEntrypointPath).href, symlinkEntrypointPath),
			).resolves.toBe(true);
			await expect(
				isCliEntrypoint(pathToFileURL(realEntrypointPath).href, undefined),
			).resolves.toBe(false);
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	});

	it('dispatches a parsed command once with the caller-provided streams', async () => {
		const io = createSilentIo();
		let serveCalls = 0;
		let receivedIo: CliIo | undefined;
		let receivedCommand: WorkerCommand | undefined;
		const operations: WorkerCliOperations = {
			runHealth: async (): Promise<void> => undefined,
			runServe: async (options, operationIo): Promise<void> => {
				serveCalls += 1;
				receivedIo = operationIo;
				receivedCommand = { command: 'serve', options };
			},
		};

		await runAgentVmWorkerCli(['serve', '--port', '19123'], io, operations);

		expect(serveCalls).toBe(1);
		expect(receivedIo).toBe(io);
		expect(receivedCommand).toEqual({
			command: 'serve',
			options: { config: undefined, port: 19_123, stateDir: undefined },
		});
	});

	it('keeps operation failures as in-process promise failures', async () => {
		const operations: WorkerCliOperations = {
			runHealth: async (): Promise<void> => {
				throw new Error('health operation failed');
			},
			runServe: async (): Promise<void> => undefined,
		};

		await expect(runAgentVmWorkerCli(['health'], createSilentIo(), operations)).rejects.toThrow(
			'health operation failed',
		);
	});

	it('prints top-level help through injected stdout', async () => {
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

	it('prints serve help through injected stdout', async () => {
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

	it('preserves the short help alias for health without dispatching', async () => {
		const stdoutChunks: string[] = [];
		let healthCalls = 0;
		const operations: WorkerCliOperations = {
			runHealth: async (): Promise<void> => {
				healthCalls += 1;
			},
			runServe: async (): Promise<void> => undefined,
		};

		await runAgentVmWorkerCli(
			['health', '-h'],
			{
				stdout: {
					write: (chunk: string | Uint8Array) => {
						stdoutChunks.push(String(chunk));
						return true;
					},
				},
				stderr: { write: () => true },
			},
			operations,
		);

		expect(stdoutChunks.join('')).toContain('health');
		expect(stdoutChunks.join('')).toContain('--port');
		expect(healthCalls).toBe(0);
	});

	it('writes successful health JSON to the injected stdout', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
		);
		const stdoutChunks: string[] = [];

		await runAgentVmWorkerCli(['health'], {
			stdout: {
				write: (chunk: string | Uint8Array) => {
					stdoutChunks.push(String(chunk));
					return true;
				},
			},
			stderr: { write: () => true },
		});

		expect(stdoutChunks.join('')).toBe('{\n  "status": "ok"\n}\n');
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
