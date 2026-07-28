import {
	GatewayControlRpcCommandResultMessageSchema,
	type GatewayControlToolVmBindingPublication,
} from '@agent-vm/gateway-control-contracts';
import { describe, expect, it, vi } from 'vitest';

import { createGatewayControlBindingPublicationHandler } from './gateway-control-binding-publication-handler.js';
import type { GatewayControlApplicationMessageContext } from './gateway-control-endpoint-contracts.js';

const publication = {
	authority: {
		attachmentGeneration: 1,
		connectionId: '11111111-1111-4111-8111-111111111111',
		controllerEpoch: 'controller-a',
		gatewayEpoch: 'gateway-a',
		processEpoch: 'process-a',
		sessionId: '22222222-2222-4222-8222-222222222222',
		zoneId: 'zone-a',
	},
	binding: {
		agentId: 'agent-a',
		idleTtlMs: 60_000,
		leafGeneration: 'leaf-a',
		leaseId: 'lease-a',
		profileAssignmentRevision: 'assignment-a',
		ssh: {
			host: 'tool-a.vm',
			identityPem: 'private-key',
			knownHostsLine: 'tool-a.vm ssh-ed25519 AAAAC3Nza',
			port: 22,
			user: 'root',
		},
		sshBindingId: 'ssh-a',
		stablePrincipal: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		tcpSlot: 0,
		transport: 'ssh-sandbox',
		workdir: '/work',
		zoneId: 'zone-a',
	},
	kind: 'current',
	observedAtMs: 100,
} as const satisfies GatewayControlToolVmBindingPublication;

function context(
	operation: 'control_ping' | 'tool_vm_binding_publish',
): GatewayControlApplicationMessageContext {
	return {
		envelope: {
			bootId: 'process-a',
			commandId: '33333333-3333-4333-8333-333333333333',
			connectionId: publication.authority.connectionId,
			controllerEpoch: publication.authority.controllerEpoch,
			createdAtMs: 100,
			deliveryPolicy: 'critical_idempotent',
			domain: 'gateway_control',
			expiresAtMs: 10_100,
			idempotencyKey: `test:${operation}`,
			kind: 'command',
			messageId: '44444444-4444-4444-8444-444444444444',
			operation,
			peerId: 'gateway-zone-a',
			protocolVersion: 1,
			sequence: 1,
			sessionId: publication.authority.sessionId,
			zoneId: publication.authority.zoneId,
		},
		payload:
			operation === 'tool_vm_binding_publish'
				? { kind: 'command', operation, payload: publication }
				: { kind: 'command', operation, payload: {} },
	};
}

describe('Gateway control binding publication handler', () => {
	it('applies current binding publication and acknowledges controller custody', async () => {
		// Arrange
		const applyPublication = vi.fn(async () => ({
			kind: 'applied' as const,
			state: {
				connectedAtMs: 101,
				generation: publication.binding,
				kind: 'ready' as const,
				publicationObservedAtMs: 100,
			},
		}));
		const handler = createGatewayControlBindingPublicationHandler({ applyPublication });

		// Act
		const result = GatewayControlRpcCommandResultMessageSchema.parse(
			await handler.handle(context('tool_vm_binding_publish')),
		);

		// Assert
		expect(applyPublication).toHaveBeenCalledExactlyOnceWith(publication);
		expect(result).toMatchObject({
			operation: 'tool_vm_binding_publish',
			payload: { result: 'ok' },
		});
	});

	it('rejects stale or mismatched publications without exposing private material', async () => {
		// Arrange
		const applyPublication = vi.fn(async () => ({
			kind: 'ignored' as const,
			reason: 'binding_authority_mismatch' as const,
			state: {
				kind: 'unbound' as const,
				stablePrincipal: publication.binding.stablePrincipal,
			},
		}));
		const handler = createGatewayControlBindingPublicationHandler({ applyPublication });

		// Act
		const result = GatewayControlRpcCommandResultMessageSchema.parse(
			await handler.handle(context('tool_vm_binding_publish')),
		);

		// Assert
		expect(result).toMatchObject({
			operation: 'tool_vm_binding_publish',
			payload: {
				error: { errorClass: 'binding_authority_mismatch', retryable: false },
				result: 'rejected',
			},
		});
		expect(JSON.stringify(result)).not.toContain(publication.binding.ssh.identityPem);
	});

	it('retains default control ping behavior', async () => {
		// Arrange
		const handler = createGatewayControlBindingPublicationHandler({
			applyPublication: vi.fn(),
		});

		// Act
		const result = GatewayControlRpcCommandResultMessageSchema.parse(
			await handler.handle(context('control_ping')),
		);

		// Assert
		expect(result).toMatchObject({ operation: 'control_ping', payload: { result: 'ok' } });
	});
});
