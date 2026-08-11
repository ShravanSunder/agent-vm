import { Writable } from 'node:stream';

import { dispose, reset, type Config, type Sink } from '@logtape/logtape';
import { afterEach, describe, expect, it } from 'vitest';

import {
	configureProcessLogging,
	createPortalServerLogger,
	mapPortalServerLogEvent,
	type ProcessLoggingDependencies,
} from './process-logging.js';
import type { PortalServerLogEvent } from './serve-command.js';

type PortalApprovalLogEvent = Extract<
	PortalServerLogEvent,
	{ readonly event: 'mcp_portal_approval' }
>;

class CaptureWritable extends Writable {
	readonly chunks: string[] = [];
	private pendingWrite: (() => void) | undefined;

	constructor() {
		super({
			write: (chunk, _encoding, callback) => {
				const text = String(chunk);
				const midpoint = Math.floor(text.length / 2);
				this.chunks.push(text.slice(0, midpoint));
				this.chunks.push(text.slice(midpoint));
				callback();
				this.pendingWrite?.();
				this.pendingWrite = undefined;
			},
		});
	}

	waitForWrite(): Promise<void> {
		if (this.chunks.length > 0) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this.pendingWrite = resolve;
		});
	}
}

function parseJsonLines<TRecord>(chunks: readonly string[]): TRecord[] {
	const records: TRecord[] = [];
	for (const [lineIndex, line] of chunks.join('').split(/\r?\n/u).entries()) {
		if (line.length === 0) {
			continue;
		}
		try {
			records.push(JSON.parse(line) as TRecord);
		} catch (error: unknown) {
			throw new Error(`Malformed JSONL stderr record at line ${String(lineIndex + 1)}: ${line}`, {
				cause: error,
			});
		}
	}
	return records;
}

interface TrackedSink {
	readonly disposeCount: () => number;
	readonly sink: Sink & AsyncDisposable & { readonly ready: Promise<void> };
}

function createTrackedSink(): TrackedSink {
	let disposalCount = 0;
	const sink = Object.assign((_record: Parameters<Sink>[0]): void => undefined, {
		ready: Promise.resolve(),
		[Symbol.asyncDispose]: async (): Promise<void> => {
			disposalCount += 1;
		},
	});
	return {
		disposeCount: (): number => disposalCount,
		sink,
	};
}

function createTestLoggingDependencies(options: {
	readonly configure: NonNullable<ProcessLoggingDependencies['configure']>;
	readonly getConfig: NonNullable<ProcessLoggingDependencies['getConfig']>;
	readonly getOpenTelemetrySink: NonNullable<ProcessLoggingDependencies['getOpenTelemetrySink']>;
	readonly getStreamSink: NonNullable<ProcessLoggingDependencies['getStreamSink']>;
	readonly reset: NonNullable<ProcessLoggingDependencies['reset']>;
}): ProcessLoggingDependencies {
	return {
		configure: options.configure,
		getConfig: options.getConfig,
		getOpenTelemetrySink: options.getOpenTelemetrySink,
		getStreamSink: options.getStreamSink,
		reset: options.reset,
	};
}

const allPortalServerEvents = [
	{
		event: 'server_error',
		level: 'error',
		message: 'raw server failure',
		stack: 'raw stack',
	},
	{
		agentId: 'agent/one',
		clientAddress: '192.168.1.10',
		decision: 'deny',
		event: 'mcp_proxy_auth',
		level: 'warn',
		reason: 'signature-mismatch',
		timeMs: 12.5,
	},
	{
		agentId: 'agent/one',
		clientAddress: '10.0.0.1',
		event: 'mcp_proxy_auth_audit_error',
		level: 'warn',
		message: 'raw audit failure',
		timeMs: 25,
	},
	{
		agentId: 'agent/one',
		decision: 'allow',
		event: 'mcp_portal_approval',
		level: 'info',
		reason: 'per_call_evaluation',
		timeMs: 8,
		verifierReason: 'raw verifier reason',
	},
	{
		agentId: 'agent/one',
		event: 'mcp_portal_approval_audit_error',
		level: 'warn',
		message: 'raw approval audit failure',
		timeMs: 9,
	},
	{
		agentScopeId: 'scope/one',
		event: 'upstream_close_error',
		level: 'warn',
		message: 'raw upstream failure',
		namespace: 'private-namespace',
	},
] as const;

describe('MCP Portal process logging', () => {
	afterEach(async () => {
		await dispose().catch(() => undefined);
		await reset();
	});

	it('maps every typed server event to a fixed safe record', () => {
		for (const event of allPortalServerEvents) {
			const record = mapPortalServerLogEvent(event);

			expect(record.category).toEqual(['agent-vm', 'mcp-portal', 'server']);
			expect(record.message).not.toContain('raw');
			expect(record.properties).not.toHaveProperty('event');
			expect(record.properties).not.toHaveProperty('message');
			expect(record.properties).not.toHaveProperty('stack');
			expect(record.properties).not.toHaveProperty('clientAddress');
			expect(record.properties).not.toHaveProperty('verifierReason');
			expect(JSON.stringify(record.properties)).not.toContain('private-namespace');
		}
	});

	it('keeps a bounded server error discriminator for triage', () => {
		const record = mapPortalServerLogEvent({
			event: 'server_error',
			level: 'error',
			message: `${'bind failure '.repeat(20)}secret`,
		});

		expect(record.properties.failureClass).toBe('server');
		expect(record.properties.failureReason).toMatch(/^[A-Za-z0-9_-]+$/u);
		expect(record.properties.failureReason).toHaveLength(64);
		expect(record.properties.failureReason).not.toContain('secret');
	});

	it('bounds and sanitizes an unsafe approval reason before logging', () => {
		const unsafeReason = `${'secret/token?'.repeat(20)}tail`;
		const event = {
			agentId: 'agent/one',
			decision: 'deny',
			event: 'mcp_portal_approval',
			level: 'warn',
			reason: unsafeReason as PortalApprovalLogEvent['reason'],
			timeMs: 8,
		} satisfies PortalApprovalLogEvent;

		const record = mapPortalServerLogEvent(event);
		const reason = record.properties.reason;

		expect(typeof reason).toBe('string');
		expect(reason).toHaveLength(64);
		expect(reason).not.toContain('/');
		expect(reason).not.toContain('?');
		expect(reason).not.toContain(unsafeReason);
	});

	it('does not preserve credentials from a credential-bearing URL-like scope', () => {
		const credentialBearingScope =
			'https://scope-user:scope-secret@example.invalid/mcp?token=query-secret';
		const event = {
			agentId: credentialBearingScope,
			decision: 'deny',
			event: 'mcp_portal_approval',
			level: 'warn',
			timeMs: 8,
		} satisfies PortalServerLogEvent;

		const record = mapPortalServerLogEvent(event);

		expect(record.properties.scope).toBe('unknown');
		expect(JSON.stringify(record.properties)).not.toContain('scope-secret');
		expect(JSON.stringify(record.properties)).not.toContain('query-secret');
	});

	it('routes the default typed logger to bounded JSONL stderr', async () => {
		const stderr = new CaptureWritable();
		const logging = await configureProcessLogging({ stderr });
		try {
			createPortalServerLogger().log(allPortalServerEvents[1]);
			createPortalServerLogger().log(allPortalServerEvents[3]);
			await stderr.waitForWrite();
			await logging.shutdown();

			const records = parseJsonLines<{
				readonly logger?: string;
				readonly level?: string;
				readonly message?: string;
				readonly properties?: Readonly<Record<string, unknown>>;
			}>(stderr.chunks);
			expect(records).toHaveLength(2);
			const output = records[0];
			expect(output?.logger).toBe('agent-vm.mcp-portal.server');
			expect(output?.level).toBe('WARN');
			expect(output?.message).toBe('MCP Portal proxy authentication decision');
			expect(output?.properties).toMatchObject({
				clientAddressClass: 'private',
				decision: 'deny',
				reason: 'signature-mismatch',
				scope: 'agent_one',
				durationMs: 12,
			});
			expect(output?.properties).not.toHaveProperty('clientAddress');
			expect(stderr.writableEnded).toBe(false);
		} finally {
			await logging.shutdown();
		}
	});

	it('reports malformed JSONL stderr with the offending line', () => {
		expect(() => parseJsonLines(['{"complete":true}\n{"broken"\n'])).toThrow(
			'Malformed JSONL stderr record at line 2: {"broken"',
		);
	});

	it('resets and disposes this invocation after configuration installs then fails', async () => {
		const setupError = new Error('configuration failed after installation');
		const stderrSink = createTrackedSink();
		const otelSink = createTrackedSink();
		let currentConfig: Config<string, string> | null = null;
		let resetCount = 0;
		const configure = async <TSinkId extends string, TFilterId extends string>(
			config: Config<TSinkId, TFilterId>,
		): Promise<void> => {
			currentConfig = config;
			throw setupError;
		};
		const dependencies = createTestLoggingDependencies({
			configure,
			getConfig: (): Config<string, string> | null => currentConfig,
			getOpenTelemetrySink: () => otelSink.sink,
			getStreamSink: () => stderrSink.sink,
			reset: async (): Promise<void> => {
				resetCount += 1;
				currentConfig = null;
				await Promise.all([
					stderrSink.sink[Symbol.asyncDispose](),
					otelSink.sink[Symbol.asyncDispose](),
				]);
			},
		});

		await expect(
			configureProcessLogging({
				dependencies,
				stderr: new CaptureWritable(),
			}),
		).rejects.toBe(setupError);
		expect(resetCount).toBe(1);
		expect(stderrSink.disposeCount()).toBe(1);
		expect(otelSink.disposeCount()).toBe(1);
		expect(currentConfig).toBeNull();
	});

	it('preserves a pre-existing configuration when setup fails before replacement', async () => {
		const setupError = new Error('configuration rejected');
		const stderrSink = createTrackedSink();
		const otelSink = createTrackedSink();
		const existingSink = createTrackedSink();
		const existingConfig: Config<string, string> = {
			loggers: [{ category: 'existing', sinks: ['existing'] }],
			reset: false,
			sinks: { existing: existingSink.sink },
		};
		let resetCount = 0;
		const configure = async <TSinkId extends string, TFilterId extends string>(
			_config: Config<TSinkId, TFilterId>,
		): Promise<void> => {
			throw setupError;
		};
		const dependencies = createTestLoggingDependencies({
			configure,
			getConfig: (): Config<string, string> => existingConfig,
			getOpenTelemetrySink: () => otelSink.sink,
			getStreamSink: () => stderrSink.sink,
			reset: async (): Promise<void> => {
				resetCount += 1;
			},
		});

		await expect(
			configureProcessLogging({
				dependencies,
				stderr: new CaptureWritable(),
			}),
		).rejects.toBe(setupError);
		expect(resetCount).toBe(0);
		expect(stderrSink.disposeCount()).toBe(1);
		expect(otelSink.disposeCount()).toBe(1);
		expect(existingSink.disposeCount()).toBe(0);
		expect(dependencies.getConfig?.()).toBe(existingConfig);
	});

	it('rejects duplicate process setup instead of replacing the active sink', async () => {
		const first = await configureProcessLogging({ stderr: new CaptureWritable() });
		try {
			await expect(configureProcessLogging({ stderr: new CaptureWritable() })).rejects.toThrow(
				/already configured|configuration/iu,
			);
		} finally {
			await first.shutdown();
		}
	});
});
