import type { AgentVmHealthEvent } from '@agent-vm/gateway-interface';
import { describe, expect, it } from 'vitest';

import { mapHealthEventToTelemetry } from './health-event-telemetry.js';

describe('mapHealthEventToTelemetry', () => {
	it('maps lease heartbeat events without exporting raw lease identifiers', () => {
		const event = {
			agentId: 'beta-agent-secret-canary',
			elapsedMs: 37,
			errorCode: 'ssh-command-failed',
			kind: 'lease-heartbeat',
			leaseId: 'lease-secret-canary',
			observedAtMs: 1_781_445_000_000,
			result: 'failed',
			useId: 'use-secret-canary',
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent;

		const telemetry = mapHealthEventToTelemetry(event);
		const serialized = JSON.stringify(telemetry);

		expect(telemetry.log.message).toBe('agent-vm health lease-heartbeat failed');
		expect(telemetry.log.attributes).toMatchObject({
			'agent_vm.health.kind': 'lease-heartbeat',
			'agent_vm.health.result': 'failed',
			'agent_vm.health.elapsed_ms': 37,
			'agent_vm.zone.id': 'beta',
			'error.type': 'ssh-command-failed',
		});
		expect(telemetry.log.attributes['agent_vm.lease.id_hash']).toMatch(/^[a-f0-9]{16}$/u);
		expect(telemetry.log.attributes['agent_vm.lease.use_id_hash']).toMatch(/^[a-f0-9]{16}$/u);
		expect(telemetry.log.attributes['agent_vm.agent.id_hash']).toMatch(/^[a-f0-9]{16}$/u);
		expect(telemetry.metricSamples).toEqual([
			{
				attributes: {
					'agent_vm.health.kind': 'lease-heartbeat',
					'agent_vm.health.result': 'failed',
					'agent_vm.zone.id': 'beta',
				},
				name: 'agent_vm_health_events_total',
				value: 1,
			},
			{
				attributes: {
					'agent_vm.health.kind': 'lease-heartbeat',
					'agent_vm.health.result': 'failed',
					'agent_vm.zone.id': 'beta',
				},
				name: 'agent_vm_health_event_duration_ms',
				value: 37,
			},
		]);
		expect(serialized).not.toContain('lease-secret-canary');
		expect(serialized).not.toContain('use-secret-canary');
		expect(serialized).not.toContain('beta-agent-secret-canary');
	});

	it('ignores non-string error codes defensively', () => {
		const event = {
			domain: 'gateway_control',
			elapsedMs: 12,
			errorCode: null,
			kind: 'gateway-control-session',
			observedAtMs: 1_781_445_000_000,
			operation: 'control-session-heartbeat',
			peerId: 'gateway-beta',
			result: 'failed',
			zoneId: 'beta',
		} as unknown as AgentVmHealthEvent;

		const telemetry = mapHealthEventToTelemetry(event);

		expect(telemetry.log.attributes).not.toHaveProperty('error.type');
		expect(telemetry.log.attributes).toMatchObject({
			'agent_vm.gateway.operation': 'control-session-heartbeat',
			'agent_vm.health.kind': 'gateway-control-session',
			'agent_vm.health.result': 'failed',
		});
	});

	it('maps health correlation into operator-visible log attributes only', () => {
		const event = {
			agentId: 'main',
			causationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			correlationId: 'correlation-main',
			elapsedMs: 17,
			kind: 'tool-vm-ssh',
			leaseId: 'lease-main',
			observedAtMs: 1_781_445_000_000,
			operation: 'probe',
			requestId: 'request-main',
			result: 'ok',
			runId: 'run-main',
			sessionKeyDigest: 'b'.repeat(64),
			toolCallId: 'tool-call-main',
			traceId: '0123456789abcdef0123456789abcdef',
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent;

		const telemetry = mapHealthEventToTelemetry(event);

		expect(telemetry.log.attributes).toMatchObject({
			'agent_vm.causation.id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			'agent_vm.correlation.id': 'correlation-main',
			'agent_vm.request.id': 'request-main',
			'agent_vm.run.id': 'run-main',
			'agent_vm.session_key.digest': 'b'.repeat(64),
			'agent_vm.tool_call.id': 'tool-call-main',
			'agent_vm.trace.id': '0123456789abcdef0123456789abcdef',
		});
		expect(telemetry.metricSamples[0]?.attributes).not.toHaveProperty('agent_vm.trace.id');
		expect(telemetry.metricSamples[0]?.attributes).not.toHaveProperty('agent_vm.correlation.id');
	});
});
