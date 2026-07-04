import { readFile } from 'node:fs/promises';

import {
	ControlCloseSchema,
	ControlEnvelopeSchema,
	assertDerivedControlDeliveryPolicy,
	type ControlMessageReceipt,
} from '@agent-vm/control-protocol-contracts';
import { WorkerControlRpcOperationSchema } from '@agent-vm/worker-control-contracts';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
	GatewayControlDomainSchema,
	GatewayControlCallerContextRegisterPayloadSchema,
	GatewayControlControllerRequestHealthOperationSchema,
	GatewayControlHealthEventPayloadSchema,
	GatewayControlLeaseCreateIntentPayloadSchema,
	GatewayControlLeaseSnapshotSchema,
	GatewayControlRpcCommandResultMessageSchema,
	GatewayControlRpcMessageSchema,
	GatewayControlRpcOperationSchema,
	GatewayControlToolPortalControllerHostActionPayloadSchema,
	buildGatewayControlJsonSchemas,
	assertGatewayControlDomainRegistered,
	gatewayControlCommandExecutionTimeoutMsByOperation,
	gatewayControlDeliveryPolicyByKind,
	gatewayControlDeliveryPolicyByOperation,
	type GatewayControlControllerToGatewayEvents,
	type GatewayControlGatewayToControllerEvents,
	type GatewayControlRpcMessage,
} from './index.js';

async function readJsonSchemaArtifact(relativePath: string): Promise<unknown> {
	return JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8')) as unknown;
}

const gatewayCommandEnvelope = ControlEnvelopeSchema.parse({
	bootId: 'gateway-boot-a',
	commandId: '44444444-4444-4444-8444-444444444444',
	connectionId: '11111111-1111-4111-8111-111111111111',
	controllerEpoch: 'epoch-a',
	createdAtMs: 1,
	deliveryPolicy: 'critical_idempotent',
	domain: 'gateway_control',
	idempotencyKey: 'gateway-command-key',
	kind: 'command',
	messageId: '22222222-2222-4222-8222-222222222222',
	operation: 'lease_create',
	peerId: 'gateway-zone-a',
	protocolVersion: 1,
	sequence: 1,
	sessionId: '33333333-3333-4333-8333-333333333333',
	zoneId: 'zone-a',
});

describe('gateway control contract', () => {
	it('reserves the generic gateway_control domain', () => {
		expect(GatewayControlDomainSchema.parse('gateway_control')).toBe('gateway_control');
		expect(assertGatewayControlDomainRegistered()).toBe('gateway_control');
		expect(GatewayControlDomainSchema.safeParse('worker_control').success).toBe(false);
	});

	it('keeps the gateway operation union exact and separated from worker ops', () => {
		expect([...GatewayControlRpcOperationSchema.options].toSorted()).toEqual([
			'caller_context_register',
			'control_ping',
			'health_event',
			'lease_create',
			'lease_get',
			'lease_peek',
			'lease_release',
			'lease_renew',
			'lease_use_end',
			'lease_use_heartbeat',
			'lease_use_start',
			'operation_cancel',
			'recovery_command',
			'runtime_status',
			'tool_portal_controller_host_action',
		]);

		expect(GatewayControlRpcOperationSchema.safeParse('git_push').success).toBe(false);
		expect(GatewayControlRpcOperationSchema.safeParse('git_pull_default').success).toBe(false);
		expect(GatewayControlRpcOperationSchema.safeParse('worker_runtime_status').success).toBe(false);
		expect(WorkerControlRpcOperationSchema.safeParse('lease_create').success).toBe(false);
	});

	it('rejects removed controller request health vocabulary', () => {
		expect(
			GatewayControlControllerRequestHealthOperationSchema.safeParse('lease-list').success,
		).toBe(false);
	});

	it('keeps command execution budgets separate from transport ack timing', () => {
		expect(gatewayControlCommandExecutionTimeoutMsByOperation.lease_create).toBeGreaterThan(2_000);
		expect(gatewayControlCommandExecutionTimeoutMsByOperation.lease_use_start).toBeGreaterThan(
			2_000,
		);
		expect(
			gatewayControlCommandExecutionTimeoutMsByOperation.tool_portal_controller_host_action,
		).toBeGreaterThan(2_000);
		expect(Object.keys(gatewayControlCommandExecutionTimeoutMsByOperation).toSorted()).toEqual(
			[...GatewayControlRpcOperationSchema.options].toSorted(),
		);
	});

	it('exports domain JSON schemas matching the reviewed static artifact', async () => {
		await expect(
			readJsonSchemaArtifact('./gateway-control-json-schema.snapshot.json'),
		).resolves.toEqual(buildGatewayControlJsonSchemas());
	});

	it('keeps session heartbeat as a kind-derived priority message', () => {
		expect(gatewayControlDeliveryPolicyByKind).toEqual({
			heartbeat: 'critical_idempotent',
		});
		expect(
			GatewayControlRpcMessageSchema.safeParse({
				kind: 'heartbeat',
				payload: {
					elapsedMs: 1,
					observedAtMs: 1_000,
				},
			}).success,
		).toBe(true);
		expect(
			GatewayControlRpcMessageSchema.safeParse({
				kind: 'heartbeat',
				operation: 'health_event',
				payload: {
					observedAtMs: 1_000,
				},
			}).success,
		).toBe(false);
	});

	it('exports Socket.IO event maps with receipt-only message acknowledgements', () => {
		type GatewayControlMessageReceipt = Parameters<
			Parameters<GatewayControlControllerToGatewayEvents['control:message']>[2]
		>[0];
		expectTypeOf<GatewayControlMessageReceipt>().toEqualTypeOf<ControlMessageReceipt>();
		const gatewayPayload = GatewayControlRpcMessageSchema.parse({
			kind: 'command',
			operation: 'lease_create',
			payload: {
				callerContext: {
					callerContextId: '55555555-5555-4555-8555-555555555555',
				},
			},
		});
		const closePayload = ControlCloseSchema.parse({
			reason: 'normal_shutdown',
			sessionId: gatewayCommandEnvelope.sessionId,
		});
		const controllerToGatewayEvents = {
			'control:close': (payload, acknowledge) => {
				expect(payload).toEqual(closePayload);
				acknowledge({ received: true });
			},
			'control:hello': (payload, acknowledge) => {
				expect(payload.domain).toBe('gateway_control');
				acknowledge({
					connectionId: gatewayCommandEnvelope.connectionId,
					controllerEpoch: gatewayCommandEnvelope.controllerEpoch,
					outcome: 'accepted',
					sessionId: gatewayCommandEnvelope.sessionId,
				});
			},
			'control:message': (envelope, payload, acknowledge) => {
				const typedPayload: GatewayControlRpcMessage = payload;
				expect(envelope.domain).toBe('gateway_control');
				expect(typedPayload).toEqual(gatewayPayload);
				acknowledge({ received: true });
			},
		} satisfies GatewayControlControllerToGatewayEvents;
		const gatewayToControllerEvents = {
			'control:close': controllerToGatewayEvents['control:close'],
			'control:message': controllerToGatewayEvents['control:message'],
		} satisfies GatewayControlGatewayToControllerEvents;

		controllerToGatewayEvents['control:hello'](
			{
				bootId: gatewayCommandEnvelope.bootId,
				controllerEpoch: gatewayCommandEnvelope.controllerEpoch,
				domain: 'gateway_control',
				peerId: gatewayCommandEnvelope.peerId,
				protocolVersion: 1,
			},
			(response) => {
				expect(response.outcome).toBe('accepted');
			},
		);
		gatewayToControllerEvents['control:message'](
			gatewayCommandEnvelope,
			gatewayPayload,
			(receipt) => {
				expect(receipt.received).toBe(true);
			},
		);
	});

	it('allows caller-context registration evidence without weakening lease_create', () => {
		expect(
			GatewayControlCallerContextRegisterPayloadSchema.parse({
				adapterEvidence: {
					agentId: 'main',
					agentWorkspaceDir: '/home/openclaw/workspace',
					sessionKey: 'agent:main:test-session',
					workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
					zoneId: 'zone-a',
				},
			}),
		).toEqual({
			adapterEvidence: {
				agentId: 'main',
				agentWorkspaceDir: '/home/openclaw/workspace',
				sessionKey: 'agent:main:test-session',
				workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
				zoneId: 'zone-a',
			},
		});
		expect(
			GatewayControlCallerContextRegisterPayloadSchema.safeParse({
				adapterEvidence: {
					agentId: 'main',
					agentWorkspaceDir: '/home/openclaw/workspace',
					profileId: 'standard',
					sessionKey: 'agent:main:test-session',
					workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
					zoneId: 'zone-a',
				},
			}).success,
		).toBe(false);
		expect(
			GatewayControlLeaseCreateIntentPayloadSchema.safeParse({
				agentId: 'main',
				agentWorkspaceDir: '/home/openclaw/workspace',
				profileId: 'standard',
				sessionKey: 'agent:main:test-session',
				workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
				zoneId: 'zone-a',
			}).success,
		).toBe(false);
		expect(
			GatewayControlRpcCommandResultMessageSchema.parse({
				kind: 'command_result',
				operation: 'caller_context_register',
				payload: {
					callerContext: {
						callerContextId: '44444444-4444-4444-8444-444444444444',
					},
					responseToMessageId: '22222222-2222-4222-8222-222222222222',
					result: 'ok',
				},
			}).payload.callerContext,
		).toEqual({
			callerContextId: '44444444-4444-4444-8444-444444444444',
		});
	});

	it('accepts lease create intent fields and rejects controller authority fields', () => {
		const validPayload = {
			callerContext: {
				callerContextId: '44444444-4444-4444-8444-444444444444',
			},
			correlation: {
				capability: {
					name: 'shell',
					namespace: 'tool_vm',
				},
				toolCallId: 'tool-call-123',
			},
			gatewayWorkspaceDir: '/workspace/sandbox',
			idleTtlHintMs: 120_000,
		};

		expect(GatewayControlLeaseCreateIntentPayloadSchema.parse(validPayload)).toEqual(validPayload);

		for (const invalidPayload of [
			{ ...validPayload, agentId: 'main' },
			{ ...validPayload, profileId: 'standard' },
			{ ...validPayload, sessionKey: 'raw-session-key' },
			{ ...validPayload, workMountDir: '/work' },
			{ ...validPayload, hostWorkMountDir: '/Users/example/repo' },
			{ ...validPayload, sshIdentityPem: '-----BEGIN OPENSSH PRIVATE KEY-----' },
			{ ...validPayload, rawCredentialRef: 'op://vault/item/credential' },
		]) {
			expect(GatewayControlLeaseCreateIntentPayloadSchema.safeParse(invalidPayload).success).toBe(
				false,
			);
		}
	});

	it('keeps controller_host_action payload narrow to the zone_git_push intent', () => {
		const validPayload = {
			actionId: 'zone_git_push',
			callerContext: {
				callerContextId: '44444444-4444-4444-8444-444444444444',
			},
			correlation: {
				capability: {
					name: 'zone_git_push',
					namespace: 'controller_host_action',
				},
				toolCallId: 'tool-call-123',
			},
			expectedHead: 'abc123',
		};

		expect(GatewayControlToolPortalControllerHostActionPayloadSchema.parse(validPayload)).toEqual(
			validPayload,
		);

		for (const invalidPayload of [
			{ ...validPayload, argv: ['git', 'push'] },
			{ ...validPayload, cwd: '/work' },
			{ ...validPayload, env: { GITHUB_TOKEN: 'secret' } },
			{ ...validPayload, executablePath: '/usr/bin/git' },
			{ ...validPayload, hostWorkMountDir: '/Users/example/repo' },
			{ ...validPayload, correlation: undefined },
			{ ...validPayload, toolPortalAgentId: 'main' },
		]) {
			expect(
				GatewayControlToolPortalControllerHostActionPayloadSchema.safeParse(invalidPayload).success,
			).toBe(false);
		}
	});

	it('carries enough lease snapshot data for the existing Tool VM lease client contract', () => {
		expect(
			GatewayControlLeaseSnapshotSchema.parse({
				agentId: 'main',
				expiresAtMs: 120_000,
				idleTtlMs: 120_000,
				leaseId: '01890f00-0000-7000-8000-000000000001',
				ssh: {
					host: 'tool-0.vm.host',
					identityPem: 'pem',
					knownHostsLine: 'tool-0.vm.host ssh-ed25519 AAAA',
					port: 22,
					user: 'sandbox',
				},
				state: 'idle',
				tcpSlot: 0,
				transport: 'ssh-sandbox',
				workdir: '/workspace',
				zoneId: 'zone-a',
			}),
		).toEqual({
			agentId: 'main',
			expiresAtMs: 120_000,
			idleTtlMs: 120_000,
			leaseId: '01890f00-0000-7000-8000-000000000001',
			ssh: {
				host: 'tool-0.vm.host',
				identityPem: 'pem',
				knownHostsLine: 'tool-0.vm.host ssh-ed25519 AAAA',
				port: 22,
				user: 'sandbox',
			},
			state: 'idle',
			tcpSlot: 0,
			transport: 'ssh-sandbox',
			workdir: '/workspace',
			zoneId: 'zone-a',
		});
	});

	it('allows gateway commands and events but forbids event-only operations as command results', () => {
		expect(
			GatewayControlRpcMessageSchema.safeParse({
				kind: 'command',
				operation: 'lease_create',
				payload: {
					callerContext: {
						callerContextId: '44444444-4444-4444-8444-444444444444',
					},
					gatewayWorkspaceDir: '/workspace/sandbox',
				},
			}).success,
		).toBe(true);

		expect(
			GatewayControlRpcMessageSchema.safeParse({
				kind: 'event',
				operation: 'health_event',
				payload: {
					eventKind: 'gateway-control-session',
					elapsedMs: 0,
					observedAtMs: 1,
					operation: 'control-session-heartbeat',
					result: 'ok',
					safeDetails: {
						peerId: 'gateway-zone-a',
					},
				},
			}).success,
		).toBe(true);

		expect(
			GatewayControlHealthEventPayloadSchema.safeParse({
				eventKind: 'tool-vm-ssh',
				agentId: 'main',
				elapsedMs: 25,
				leaseId: 'lease-main',
				observedAtMs: 1,
				operation: 'bogus-tool-op',
				result: 'ok',
			}).success,
		).toBe(false);

		expect(
			GatewayControlHealthEventPayloadSchema.safeParse({
				eventKind: 'controller-request',
				attempt: 1,
				elapsedMs: 25,
				maxAttempts: 1,
				observedAtMs: 1,
				operation: 'lease-heartbeat',
				result: 'ok',
			}).success,
		).toBe(false);

		expect(
			GatewayControlRpcCommandResultMessageSchema.safeParse({
				kind: 'command_result',
				operation: 'tool_portal_controller_host_action',
				payload: {
					controllerHostAction: {
						actionId: 'zone_git_push',
						result: {
							branch: 'main',
							localHead: 'abc123',
							pushedCommits: [{ sha: 'abc123', subject: 'docs: update memory' }],
							remoteHead: 'abc123',
						},
					},
					responseToMessageId: '22222222-2222-4222-8222-222222222222',
					result: 'ok',
				},
			}).success,
		).toBe(true);

		expect(
			GatewayControlRpcCommandResultMessageSchema.safeParse({
				kind: 'command_result',
				operation: 'runtime_status',
				payload: {
					responseToMessageId: '22222222-2222-4222-8222-222222222222',
					result: 'ok',
				},
			}).success,
		).toBe(false);
	});

	it('binds command_result payload fields to the gateway operation', () => {
		const leaseResult = {
			agentId: 'main',
			idleTtlMs: 120_000,
			leaseId: '01890f00-0000-7000-8000-000000000001',
			state: 'idle',
			tcpSlot: 0,
			transport: 'ssh-sandbox',
			workdir: '/workspace',
			zoneId: 'zone-a',
		};

		const controllerHostActionResult = {
			actionId: 'zone_git_push',
			result: {
				branch: 'main',
				localHead: 'abc123',
				pushedCommits: [{ sha: 'abc123', subject: 'docs: update memory' }],
				remoteHead: 'abc123',
			},
		};

		expect(
			GatewayControlRpcCommandResultMessageSchema.safeParse({
				kind: 'command_result',
				operation: 'lease_create',
				payload: {
					lease: leaseResult,
					responseToMessageId: '22222222-2222-4222-8222-222222222222',
					result: 'ok',
				},
			}).success,
		).toBe(true);

		expect(
			GatewayControlRpcCommandResultMessageSchema.safeParse({
				kind: 'command_result',
				operation: 'control_ping',
				payload: {
					lease: leaseResult,
					responseToMessageId: '22222222-2222-4222-8222-222222222222',
					result: 'ok',
				},
			}).success,
		).toBe(false);

		expect(
			GatewayControlRpcCommandResultMessageSchema.safeParse({
				kind: 'command_result',
				operation: 'lease_create',
				payload: {
					controllerHostAction: controllerHostActionResult,
					responseToMessageId: '22222222-2222-4222-8222-222222222222',
					result: 'ok',
				},
			}).success,
		).toBe(false);

		expect(
			GatewayControlRpcCommandResultMessageSchema.safeParse({
				kind: 'command_result',
				operation: 'tool_portal_controller_host_action',
				payload: {
					controllerHostAction: controllerHostActionResult,
					responseToMessageId: '22222222-2222-4222-8222-222222222222',
					result: 'ok',
				},
			}).success,
		).toBe(true);
	});

	it('covers every gateway operation with a derived delivery policy', () => {
		expect(Object.keys(gatewayControlDeliveryPolicyByOperation).toSorted()).toEqual(
			[...GatewayControlRpcOperationSchema.options].toSorted(),
		);

		expect(() =>
			assertDerivedControlDeliveryPolicy({
				envelope: gatewayCommandEnvelope,
				policyByOperation: gatewayControlDeliveryPolicyByOperation,
			}),
		).not.toThrow();

		expect(() =>
			assertDerivedControlDeliveryPolicy({
				envelope: {
					...gatewayCommandEnvelope,
					deliveryPolicy: 'latest_wins',
				},
				policyByOperation: gatewayControlDeliveryPolicyByOperation,
			}),
		).toThrow(/delivery policy mismatch/u);
	});
});
