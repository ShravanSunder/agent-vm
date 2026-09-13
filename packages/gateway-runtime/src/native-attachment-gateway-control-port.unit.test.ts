import { GatewayStablePrincipalDigestSchema } from '@agent-vm/agent-portal-sdk/contracts';
import { GatewayControlRpcCommandResultMessageSchema } from '@agent-vm/gateway-control-contracts';
import { describe, expect, it, vi } from 'vitest';

import type { GatewayRuntimeControlCommandClient } from './control-endpoint/gateway-control-command-client.js';
import { createGatewayControlNativeAttachmentPort } from './native-attachment-gateway-control-port.js';

const messageId = '20000000-0000-4000-8000-000000000002';
const callerContextId = '10000000-0000-4000-8000-000000000001';
const trustedContext = {
	correlation: { sessionId: 'captured-session' },
	principal: {
		agentId: 'sun',
		frameworkIdentity: { kind: 'hermes' as const, profileName: 'sun' },
		profileAssignmentRevision: 'revision',
		toolPortalProfileId: 'profile',
	},
};
const stageRequest = {
	action: 'stage' as const,
	source: { kind: 'tool-vm-file' as const, path: './report.pdf' },
};

function fixture(matching: boolean): {
	readonly register: ReturnType<typeof vi.fn>;
	readonly sendCommand: ReturnType<typeof vi.fn<GatewayRuntimeControlCommandClient['sendCommand']>>;
	readonly access: ReturnType<typeof createGatewayControlNativeAttachmentPort>;
} {
	const register = vi.fn(async () => ({
		callerContextId,
		admissionPrincipal: GatewayStablePrincipalDigestSchema.parse('a'.repeat(64)),
	}));
	const sendCommand = vi.fn<GatewayRuntimeControlCommandClient['sendCommand']>(async () => ({
		acceptedSession: {
			attachmentGeneration: 1,
			bootId: 'boot',
			connectionId: messageId,
			controllerEpoch: 'controller',
			gatewayEpoch: 'gateway',
			generationId: 'generation',
			peerId: 'peer',
			processEpoch: 'process',
			sessionId: callerContextId,
			zoneId: 'zone',
		},
		messageId,
		response: GatewayControlRpcCommandResultMessageSchema.parse({
			kind: 'command_result',
			operation: 'tool_portal_attachment',
			payload: {
				result: 'ok',
				responseToMessageId: matching ? messageId : callerContextId,
				nativeAttachment: { kind: 'unavailable' },
			},
		}),
	}));
	return {
		register,
		sendCommand,
		access: createGatewayControlNativeAttachmentPort({
			callerContextRegistrationClient: { register, close: async () => {} },
			controlCommandClient: { sendCommand },
			now: () => 1000,
		}),
	};
}

describe('native attachment Gateway control forwarding', () => {
	it.each([true, false])(
		'binds only the trusted captured session and rejects wrong response correlation (%s)',
		async (matching) => {
			// Arrange
			const current = fixture(matching);
			// Act / Assert
			const result = current.access({
				publicRequest: stageRequest,
				trustedContext,
				signal: new AbortController().signal,
			});
			if (matching) await expect(result).resolves.toEqual({ kind: 'unavailable' });
			else await expect(result).rejects.toThrow('did not match its request');
			expect(current.register).toHaveBeenCalledExactlyOnceWith({
				purpose: 'tool_portal_controller_execution',
				trustedContext,
			});
			expect(current.sendCommand).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					createdAtMs: 1000,
					expiresAtMs: 121000,
					message: {
						kind: 'command',
						operation: 'tool_portal_attachment',
						payload: {
							callerContext: { callerContextId },
							request: stageRequest,
							sessionId: 'captured-session',
						},
					},
				}),
			);
		},
	);

	it('refuses missing session context before registering a caller or issuing a command', async () => {
		// Arrange
		const current = fixture(true);
		// Act / Assert
		await expect(
			current.access({
				publicRequest: stageRequest,
				trustedContext: { principal: trustedContext.principal },
				signal: new AbortController().signal,
			}),
		).resolves.toEqual({ kind: 'unavailable' });
		expect(current.register).not.toHaveBeenCalled();
		expect(current.sendCommand).not.toHaveBeenCalled();
	});

	it('does not send a cancelled request after asynchronous caller registration', async () => {
		// Arrange
		const abort = new AbortController();
		const current = fixture(true);
		const access = createGatewayControlNativeAttachmentPort({
			callerContextRegistrationClient: {
				close: async () => {},
				register: async () => {
					abort.abort();
					return {
						callerContextId,
						admissionPrincipal: GatewayStablePrincipalDigestSchema.parse('a'.repeat(64)),
					};
				},
			},
			controlCommandClient: { sendCommand: current.sendCommand },
		});
		// Act / Assert
		await expect(
			access({ publicRequest: stageRequest, trustedContext, signal: abort.signal }),
		).rejects.toThrow();
		expect(current.sendCommand).not.toHaveBeenCalled();
	});
});
