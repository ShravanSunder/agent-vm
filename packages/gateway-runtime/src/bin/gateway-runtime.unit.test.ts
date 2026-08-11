import { configure, dispose, reset, type LogRecord, type Sink } from '@logtape/logtape';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	runGatewayRuntimeStartLifecycle,
	type GatewayRuntimeRetirementSignal,
	type GatewayRuntimeSignalTarget,
	waitForRetirementSignal,
} from './gateway-runtime.js';

interface FakeSignalTarget extends GatewayRuntimeSignalTarget {
	readonly escalatedSignals: NodeJS.Signals[];
	readonly emit: (signal: 'SIGINT' | 'SIGTERM') => void;
	readonly listenerCount: (signal: 'SIGINT' | 'SIGTERM') => number;
}

function createFakeSignalTarget(): FakeSignalTarget {
	const listeners = new Map<'SIGINT' | 'SIGTERM', () => void>();
	const escalatedSignals: NodeJS.Signals[] = [];
	return {
		escalate: (signal): void => {
			escalatedSignals.push(signal);
		},
		escalatedSignals,
		emit: (signal): void => {
			listeners.get(signal)?.();
		},
		listenerCount: (signal): number => (listeners.has(signal) ? 1 : 0),
		off: (signal, listener): void => {
			if (listeners.get(signal) === listener) listeners.delete(signal);
		},
		on: (signal, listener): void => {
			listeners.set(signal, listener);
		},
	};
}

afterEach(async () => {
	await dispose().catch(() => undefined);
	await reset();
});

async function configureDiagnosticCapture(records: LogRecord[]): Promise<void> {
	const sink: Sink = (record): void => {
		records.push(record);
	};
	await configure({
		loggers: [
			{
				category: ['agent-vm', 'gateway-runtime', 'process'],
				lowestLevel: 'trace',
				sinks: ['capture'],
			},
		],
		reset: false,
		sinks: { capture: sink },
	});
}

describe('Gateway Runtime start lifecycle', () => {
	it('resolves the first signal, escalates a repeated signal, and cleans up idempotently', async () => {
		const signalTarget = createFakeSignalTarget();
		const pendingSignal = waitForRetirementSignal(signalTarget);

		signalTarget.emit('SIGTERM');
		const firstSignal = await pendingSignal;

		expect(firstSignal).toMatchObject({ signal: 'SIGTERM' });
		expect(signalTarget.listenerCount('SIGTERM')).toBe(1);
		signalTarget.emit('SIGTERM');
		expect(signalTarget.escalatedSignals).toEqual(['SIGTERM']);
		expect(signalTarget.listenerCount('SIGTERM')).toBe(0);
		firstSignal.cleanup();
		firstSignal.cleanup();
		expect(signalTarget.listenerCount('SIGTERM')).toBe(0);
	});

	it('preserves logging configuration failure as the error cause', async () => {
		const configurationFailure = new Error('secret logging configuration detail');

		await expect(
			runGatewayRuntimeStartLifecycle({
				config: { observability: { kind: 'disabled' } },
				configureLogging: async (): Promise<never> => {
					throw configurationFailure;
				},
				startService: async () => ({
					readiness: { kind: 'ready' },
					retire: async (): Promise<Readonly<Record<string, string>>> => ({
						kind: 'retired',
					}),
				}),
				waitForRetirementSignal: async (): Promise<GatewayRuntimeRetirementSignal> => ({
					cleanup: (): void => undefined,
					signal: 'SIGTERM',
				}),
				writeFatalEvidence: async (): Promise<void> => undefined,
				writeStderr: (): void => undefined,
				writeStdout: (): void => undefined,
			}),
		).rejects.toMatchObject({
			cause: configurationFailure,
			message: 'Gateway runtime process logging setup failed.',
		});
	});

	it('configures logging before service start and disposes it after retirement', async () => {
		const events: string[] = [];
		const stdout: string[] = [];
		const stderr: string[] = [];
		const service = {
			readiness: { kind: 'ready' },
			retire: vi.fn(async (): Promise<Readonly<Record<string, string>>> => {
				events.push('retire');
				return { kind: 'retired' };
			}),
		};

		await runGatewayRuntimeStartLifecycle({
			config: { observability: { kind: 'disabled' } },
			configureLogging: async (): Promise<{ shutdown: () => Promise<void> }> => {
				events.push('configure-logging');
				return {
					shutdown: async (): Promise<void> => {
						events.push('dispose-logging');
					},
				};
			},
			startService: async (): Promise<typeof service> => {
				events.push('start-service');
				return service;
			},
			waitForRetirementSignal: async (): Promise<GatewayRuntimeRetirementSignal> => {
				events.push('wait-for-signal');
				return {
					cleanup: (): void => {
						events.push('cleanup-signal');
					},
					signal: 'SIGTERM',
				};
			},
			writeFatalEvidence: async (): Promise<void> => {
				events.push('fatal-evidence');
			},
			writeStderr: (text: string): void => {
				stderr.push(text);
			},
			writeStdout: (text: string): void => {
				events.push(`write-stdout:${text.trim()}`);
				stdout.push(text);
			},
		});

		expect(events).toEqual([
			'configure-logging',
			'start-service',
			'wait-for-signal',
			'write-stdout:{"kind":"ready"}',
			'retire',
			'write-stdout:{"kind":"retired"}',
			'dispose-logging',
			'cleanup-signal',
		]);
		expect(stdout).toEqual(['{"kind":"ready"}\n', '{"kind":"retired"}\n']);
		expect(stderr).toEqual([]);
	});

	it('keeps a successful retirement result when LogTape disposal fails', async () => {
		const stdout: string[] = [];
		const stderr: string[] = [];

		await runGatewayRuntimeStartLifecycle({
			config: { observability: { kind: 'disabled' } },
			configureLogging: async (): Promise<{ shutdown: () => Promise<void> }> => ({
				shutdown: async (): Promise<void> => {
					throw new Error('sink failure');
				},
			}),
			startService: async () => ({
				readiness: { kind: 'ready' },
				retire: async (): Promise<Readonly<Record<string, string>>> => ({ kind: 'retired' }),
			}),
			waitForRetirementSignal: async (): Promise<GatewayRuntimeRetirementSignal> => ({
				cleanup: (): void => undefined,
				signal: 'SIGTERM',
			}),
			writeFatalEvidence: async (): Promise<void> => undefined,
			writeStderr: (text: string): void => {
				stderr.push(text);
			},
			writeStdout: (text: string): void => {
				stdout.push(text);
			},
		});

		expect(stdout).toEqual(['{"kind":"ready"}\n', '{"kind":"retired"}\n']);
		expect(stderr).toEqual(['Gateway runtime logging shutdown failed.\n']);
	});

	it('reports secondary LogTape shutdown failure after startup failure', async () => {
		const stderr: string[] = [];
		const fatalEvidence = vi.fn(async (): Promise<void> => undefined);
		const events: string[] = [];
		let loggingLive = true;

		await expect(
			runGatewayRuntimeStartLifecycle({
				config: { observability: { kind: 'disabled' } },
				configureLogging: async (): Promise<{ shutdown: () => Promise<void> }> => ({
					shutdown: async (): Promise<void> => {
						events.push('shutdown');
						loggingLive = false;
						throw new Error('sink failure');
					},
				}),
				startService: async (): Promise<never> => {
					throw new Error('primary startup failure');
				},
				waitForRetirementSignal: async (): Promise<GatewayRuntimeRetirementSignal> => ({
					cleanup: (): void => undefined,
					signal: 'SIGTERM',
				}),
				writeFatalEvidence: async (): Promise<void> => {
					events.push(`fatal-evidence:${String(loggingLive)}`);
					await fatalEvidence();
				},
				writeStderr: (text: string): void => {
					stderr.push(text);
				},
				writeStdout: (): void => undefined,
			}),
		).rejects.toThrow('primary startup failure');

		expect(fatalEvidence).toHaveBeenCalledTimes(1);
		expect(events).toEqual(['fatal-evidence:true', 'shutdown']);
		expect(stderr).toEqual(['Gateway runtime logging shutdown failed.\n']);
	});

	it('keeps startup failure primary when fatal evidence fails and emits bounded evidence diagnostics', async () => {
		const records: LogRecord[] = [];
		const stderr: string[] = [];
		await configureDiagnosticCapture(records);

		await expect(
			runGatewayRuntimeStartLifecycle({
				config: { observability: { kind: 'disabled' } },
				configureLogging: async (): Promise<{ shutdown: () => Promise<void> }> => ({
					shutdown: async (): Promise<void> => undefined,
				}),
				startService: async (): Promise<never> => {
					throw new Error('secret startup detail');
				},
				waitForRetirementSignal: async (): Promise<GatewayRuntimeRetirementSignal> => ({
					cleanup: (): void => undefined,
					signal: 'SIGTERM',
				}),
				writeFatalEvidence: async (): Promise<void> => {
					throw new Error('secret evidence detail');
				},
				writeStderr: (text: string): void => {
					stderr.push(text);
				},
				writeStdout: (): void => undefined,
			}),
		).rejects.toThrow('secret startup detail');

		expect(records).toContainEqual(
			expect.objectContaining({
				category: ['agent-vm', 'gateway-runtime', 'process'],
				level: 'error',
				properties: { event: 'fatal-evidence-write-failed', failureClass: 'startup' },
				rawMessage: 'Gateway runtime fatal evidence write failed.',
			}),
		);
		expect(JSON.stringify(records)).not.toContain('secret evidence detail');
		expect(stderr).toEqual([]);
	});

	it('logs startup failure without capturing the thrown error or changing fatal evidence', async () => {
		const records: LogRecord[] = [];
		await configureDiagnosticCapture(records);
		const fatalEvidence = vi.fn(async (): Promise<void> => undefined);

		await expect(
			runGatewayRuntimeStartLifecycle({
				config: { observability: { kind: 'disabled' } },
				configureLogging: async (): Promise<{ shutdown: () => Promise<void> }> => ({
					shutdown: async (): Promise<void> => undefined,
				}),
				startService: async (): Promise<never> => {
					throw new Error('secret startup detail');
				},
				waitForRetirementSignal: async (): Promise<GatewayRuntimeRetirementSignal> => ({
					cleanup: (): void => undefined,
					signal: 'SIGTERM',
				}),
				writeFatalEvidence: fatalEvidence,
				writeStderr: (): void => undefined,
				writeStdout: (): void => undefined,
			}),
		).rejects.toThrow('secret startup detail');

		expect(fatalEvidence).toHaveBeenCalledTimes(1);
		expect(records).toContainEqual(
			expect.objectContaining({
				category: ['agent-vm', 'gateway-runtime', 'process'],
				level: 'error',
				properties: { event: 'startup-failed', failureClass: 'startup' },
				rawMessage: 'Gateway runtime service startup failed.',
			}),
		);
		expect(JSON.stringify(records)).not.toContain('secret startup detail');
	});

	it('logs retirement failure without changing the product failure result', async () => {
		const records: LogRecord[] = [];
		await configureDiagnosticCapture(records);

		await expect(
			runGatewayRuntimeStartLifecycle({
				config: { observability: { kind: 'disabled' } },
				configureLogging: async (): Promise<{ shutdown: () => Promise<void> }> => ({
					shutdown: async (): Promise<void> => undefined,
				}),
				startService: async () => ({
					readiness: { kind: 'ready' },
					retire: async (): Promise<never> => {
						throw new Error('secret retirement detail');
					},
				}),
				waitForRetirementSignal: async (): Promise<GatewayRuntimeRetirementSignal> => ({
					cleanup: (): void => undefined,
					signal: 'SIGTERM',
				}),
				writeFatalEvidence: async (): Promise<void> => undefined,
				writeStderr: (): void => undefined,
				writeStdout: (): void => undefined,
			}),
		).rejects.toThrow('secret retirement detail');

		expect(records).toContainEqual(
			expect.objectContaining({
				category: ['agent-vm', 'gateway-runtime', 'process'],
				level: 'error',
				properties: { event: 'retirement-failed', failureClass: 'retirement' },
				rawMessage: 'Gateway runtime service retirement failed.',
			}),
		);
		expect(JSON.stringify(records)).not.toContain('secret retirement detail');
	});

	it('preserves retirement failure when logging shutdown and fallback writing both fail', async () => {
		const retirementFailure = new Error('retirement failed');
		const fallbackFailure = new Error('stderr fallback failed');

		await expect(
			runGatewayRuntimeStartLifecycle({
				config: { observability: { kind: 'disabled' } },
				configureLogging: async (): Promise<{ shutdown: () => Promise<void> }> => ({
					shutdown: async (): Promise<void> => {
						throw new Error('logging shutdown failed');
					},
				}),
				startService: async () => ({
					readiness: { kind: 'ready' },
					retire: async (): Promise<never> => {
						throw retirementFailure;
					},
				}),
				waitForRetirementSignal: async (): Promise<GatewayRuntimeRetirementSignal> => ({
					cleanup: (): void => undefined,
					signal: 'SIGTERM',
				}),
				writeFatalEvidence: async (): Promise<void> => undefined,
				writeStderr: (): void => {
					throw fallbackFailure;
				},
				writeStdout: (): void => undefined,
			}),
		).rejects.toBe(retirementFailure);
	});
});
