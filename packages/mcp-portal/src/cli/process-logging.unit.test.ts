import { Writable } from 'node:stream';

import { reset } from '@logtape/logtape';
import { afterEach, describe, expect, it } from 'vitest';

import {
	configureProcessLogging,
	createPortalServerLogger,
	mapPortalServerLogEvent,
} from './process-logging.js';
import type { PortalServerLogEvent } from './serve-command.js';

class CaptureWritable extends Writable {
	readonly chunks: string[] = [];
	private pendingWrite: (() => void) | undefined;

	constructor() {
		super({
			write: (chunk, _encoding, callback) => {
				this.chunks.push(String(chunk));
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

	it('bounds and sanitizes an unsafe approval reason before logging', () => {
		const unsafeReason = `${'secret/token?'.repeat(20)}tail`;
		const event = {
			agentId: 'agent/one',
			decision: 'deny',
			event: 'mcp_portal_approval',
			level: 'warn',
			reason: unsafeReason,
			timeMs: 8,
		} as unknown as PortalServerLogEvent;

		const record = mapPortalServerLogEvent(event);
		const reason = record.properties.reason;

		expect(typeof reason).toBe('string');
		expect(reason).toHaveLength(64);
		expect(reason).not.toContain('/');
		expect(reason).not.toContain('?');
		expect(reason).not.toContain(unsafeReason);
	});

	it('routes the default typed logger to bounded JSONL stderr', async () => {
		const stderr = new CaptureWritable();
		const logging = await configureProcessLogging({ stderr });
		try {
			createPortalServerLogger().log(allPortalServerEvents[1]);
			await stderr.waitForWrite();
			await new Promise<void>((resolve) => setImmediate(resolve));
			await logging.shutdown();

			const output = JSON.parse(stderr.chunks[0] ?? '{}') as {
				readonly logger?: string;
				readonly level?: string;
				readonly message?: string;
				readonly properties?: Readonly<Record<string, unknown>>;
			};
			expect(output.logger).toBe('agent-vm.mcp-portal.server');
			expect(output.level).toBe('WARN');
			expect(output.message).toBe('MCP Portal proxy authentication decision');
			expect(output.properties).toMatchObject({
				clientAddressClass: 'private',
				decision: 'deny',
				reason: 'signature-mismatch',
				scope: 'agent_one',
				durationMs: 12,
			});
			expect(output.properties).not.toHaveProperty('clientAddress');
		} finally {
			await logging.shutdown();
		}
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
