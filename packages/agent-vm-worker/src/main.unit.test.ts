import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { getConfig, reset } from '@logtape/logtape';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	handleCliMainError,
	isCliEntrypoint,
	ReportedCliError,
	runAgentVmWorkerCli,
	runWorkerProcess,
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
		await runAgentVmWorkerCli({
			argv: ['serve', '--config', '', '--state-dir', ''],
			io: createSilentIo(),
			operations,
		});

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

		await runAgentVmWorkerCli({ argv: ['serve', '--port', '19123'], io, operations });

		expect(serveCalls).toBe(1);
		expect(receivedIo).toBe(io);
		expect(receivedCommand).toEqual({
			command: 'serve',
			options: { config: undefined, port: 19_123, stateDir: undefined },
		});
	});

	it('configures process logging before dispatching the worker operation', async () => {
		const stderr = new Writable({ write: (_chunk, _encoding, callback) => callback() });
		const observedConfiguration: boolean[] = [];
		const operations: WorkerCliOperations = {
			runHealth: async (): Promise<void> => undefined,
			runServe: async (_options, _io, logging): Promise<void> => {
				observedConfiguration.push(getConfig() !== null);
				await logging?.shutdown();
			},
		};

		try {
			await runWorkerProcess({ argv: ['serve'], io: { stdout: stderr, stderr }, operations });
			expect(observedConfiguration).toEqual([true]);
		} finally {
			if (getConfig() !== null) await reset();
		}
	});

	it('does not configure or shut down logging for help output', async () => {
		const stdoutChunks: string[] = [];
		const shutdown = vi.fn(async (): Promise<void> => undefined);
		const configureLogging = vi.fn(async () => ({ shutdown }));

		await expect(
			runWorkerProcess({
				argv: ['--help'],
				io: {
					stdout: new Writable({
						write: (chunk, _encoding, callback): void => {
							stdoutChunks.push(String(chunk));
							callback();
						},
					}),
					stderr: new Writable({ write: (_chunk, _encoding, callback): void => callback() }),
				},
				configureProcessLogging: configureLogging,
			}),
		).resolves.toBeUndefined();

		expect(configureLogging).not.toHaveBeenCalled();
		expect(shutdown).not.toHaveBeenCalled();
		expect(stdoutChunks.join('')).toContain('agent-vm-worker');
	});

	it('preserves a worker operation failure when shutdown and fallback writing both fail', async () => {
		const operationFailure = new Error('worker operation failed');
		const fallbackFailure = new Error('stderr fallback failed');
		const shutdown = vi.fn(async (): Promise<void> => {
			throw new Error('logging shutdown failed');
		});
		const operations: WorkerCliOperations = {
			runHealth: async (): Promise<void> => undefined,
			runServe: async (): Promise<void> => {
				throw operationFailure;
			},
		};

		await expect(
			runWorkerProcess({
				argv: ['serve'],
				io: {
					stdout: new Writable({ write: (_chunk, _encoding, callback): void => callback() }),
					stderr: new Writable({
						write: (): never => {
							throw fallbackFailure;
						},
					}),
				},
				operations,
				configureProcessLogging: async () => ({ shutdown }),
			}),
		).rejects.toBe(operationFailure);
	});

	it('keeps process logging setup failure bounded at the worker root', async () => {
		const stderrChunks: string[] = [];
		const setupError = new Error('connect https://collector.invalid/v1/logs with stack details');
		let startupError: unknown;
		try {
			await runWorkerProcess({
				argv: ['serve'],
				io: {
					stderr: new Writable({
						write: (chunk: Uint8Array, _encoding, callback): void => {
							stderrChunks.push(Buffer.from(chunk).toString('utf8'));
							callback();
						},
					}),
					stdout: new Writable({
						write: (_chunk, _encoding, callback): void => callback(),
					}),
				},
				configureProcessLogging: async () => {
					throw setupError;
				},
			});
		} catch (error: unknown) {
			startupError = error;
		}

		expect(startupError).toBeInstanceOf(Error);
		expect(startupError).toMatchObject({
			message: 'Worker process logging setup failed.',
			cause: setupError,
		});
		handleCliMainError(startupError, {
			write: (chunk: string | Uint8Array): boolean => {
				stderrChunks.push(String(chunk));
				return true;
			},
		});
		expect(stderrChunks).toEqual(['Worker process logging setup failed.\n']);
	});

	it('reports secondary logging shutdown failure without changing a successful serve result', async () => {
		const stderrChunks: string[] = [];
		const stderr = new Writable({
			write: (chunk: Uint8Array, _encoding, callback): void => {
				stderrChunks.push(Buffer.from(chunk).toString('utf8'));
				callback();
			},
		});
		const configureLogging = vi.fn(async () => ({
			shutdown: async (): Promise<void> => {
				throw new Error('logging shutdown failed');
			},
		}));
		const operations: WorkerCliOperations = {
			runHealth: async (): Promise<void> => undefined,
			runServe: async (): Promise<void> => undefined,
		};

		await expect(
			runWorkerProcess({
				argv: ['serve'],
				io: { stdout: stderr, stderr },
				operations,
				configureProcessLogging: configureLogging,
			}),
		).resolves.toBeUndefined();
		expect(stderrChunks.join('')).toContain('Worker process logging shutdown failed.\n');
	});

	it('keeps operation failures as in-process promise failures', async () => {
		const operations: WorkerCliOperations = {
			runHealth: async (): Promise<void> => {
				throw new Error('health operation failed');
			},
			runServe: async (): Promise<void> => undefined,
		};

		await expect(
			runAgentVmWorkerCli({ argv: ['health'], io: createSilentIo(), operations }),
		).rejects.toThrow('health operation failed');
	});

	it('prints top-level help through injected stdout', async () => {
		const stdoutChunks: string[] = [];

		await expect(
			runAgentVmWorkerCli({
				argv: ['--help'],
				io: {
					stdout: {
						write: (chunk: string | Uint8Array) => {
							stdoutChunks.push(String(chunk));
							return true;
						},
					},
					stderr: { write: () => true },
				},
			}),
		).resolves.toBeUndefined();

		expect(stdoutChunks.join('')).toContain('agent-vm-worker');
		expect(stdoutChunks.join('')).toContain('serve');
		expect(stdoutChunks.join('')).toContain('health');
	});

	it('prints serve help through injected stdout', async () => {
		const stdoutChunks: string[] = [];

		await expect(
			runAgentVmWorkerCli({
				argv: ['serve', '--help'],
				io: {
					stdout: {
						write: (chunk: string | Uint8Array) => {
							stdoutChunks.push(String(chunk));
							return true;
						},
					},
					stderr: { write: () => true },
				},
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

		await runAgentVmWorkerCli({
			argv: ['health', '-h'],
			io: {
				stdout: {
					write: (chunk: string | Uint8Array) => {
						stdoutChunks.push(String(chunk));
						return true;
					},
				},
				stderr: { write: () => true },
			},
			operations,
		});

		expect(stdoutChunks.join('')).toContain('health');
		expect(stdoutChunks.join('')).toContain('--port');
		expect(healthCalls).toBe(0);
	});

	it('writes successful health JSON to the injected stdout', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
		);
		const stdoutChunks: string[] = [];

		await runAgentVmWorkerCli({
			argv: ['health'],
			io: {
				stdout: {
					write: (chunk: string | Uint8Array) => {
						stdoutChunks.push(String(chunk));
						return true;
					},
				},
				stderr: { write: () => true },
			},
		});

		expect(stdoutChunks.join('')).toBe('{\n  "status": "ok"\n}\n');
	});

	it('reports health check failures without hard process exit', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(null, { status: 503 }));
		const stderrChunks: string[] = [];

		await expect(
			runAgentVmWorkerCli({
				argv: ['health', '--port', '19999'],
				io: {
					stdout: { write: () => true },
					stderr: {
						write: (chunk: string | Uint8Array) => {
							stderrChunks.push(String(chunk));
							return true;
						},
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
