import { readFile } from 'node:fs/promises';

import {
	ControlCloseSchema,
	ControlEnvelopeSchema,
	assertDerivedControlDeliveryPolicy,
	type ControlMessageReceipt,
} from '@agent-vm/control-protocol-contracts';
import { WorkerControlRpcOperationSchema } from '@agent-vm/worker-control-contracts';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type * as GatewayControlContracts from './index.js';
import {
	GatewayControlDomainSchema,
	GatewayControlCallerContextRegisterPayloadSchema,
	GatewayControlControllerRequestHealthOperationSchema,
	GatewayControlHealthEventPayloadSchema,
	GatewayControlHelloSchema,
	GatewayControlLeaseCreateIntentPayloadSchema,
	GatewayControlPrivateLeaseSnapshotSchema,
	GatewayControlLeaseRejectionReasonSchema,
	GatewayControlLeaseSnapshotSchema,
	GatewayControlRpcCommandResultMessageSchema,
	GatewayControlRpcMessageSchema,
	GatewayControlRpcOperationSchema,
	GatewayControlToolVmBindingPublicationSchema,
	GatewayControlToolPortalControllerHostActionPayloadSchema,
	createGatewayRuntimeReadinessSnapshot,
	buildGatewayControlJsonSchemas,
	assertGatewayControlDomainRegistered,
	assertGatewayControlEnvelopeDeliveryPolicy,
	classifyGatewayControlAdmission,
	deriveGatewayControlDeliveryPolicy,
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
	it('does not re-export the retired gateway-control principal schema name', () => {
		expectTypeOf<typeof GatewayControlContracts>().not.toHaveProperty(
			'GatewayControlAdmissionPrincipalSchema',
		);
	});

	it('exports only workspace Git host-action vocabulary', () => {
		expectTypeOf<typeof GatewayControlContracts>().toHaveProperty(
			'GatewayControlWorkspaceGitPushControllerHostActionPayloadSchema',
		);
		expectTypeOf<typeof GatewayControlContracts>().toHaveProperty(
			'GatewayControlWorkspaceGitPushResultSchema',
		);
	});

	it('binds hello to C/G/P and a positive attachment generation without resync fields', () => {
		const hello = {
			attachmentGeneration: 7,
			controllerEpoch: 'controller-epoch-a',
			domain: 'gateway_control',
			gatewayEpoch: 'gateway-epoch-a',
			peerId: 'gateway-zone-a',
			processEpoch: 'process-epoch-a',
			protocolVersion: 1,
		} as const;

		expect(GatewayControlHelloSchema.parse(hello)).toEqual(hello);
		expect(GatewayControlHelloSchema.safeParse({ ...hello, attachmentGeneration: 0 }).success).toBe(
			false,
		);
		expect(
			GatewayControlHelloSchema.safeParse({
				...hello,
				previousSessionId: '33333333-3333-4333-8333-333333333333',
			}).success,
		).toBe(false);
	});

	it('reserves the generic gateway_control domain', () => {
		expect(GatewayControlDomainSchema.parse('gateway_control')).toBe('gateway_control');
		expect(assertGatewayControlDomainRegistered()).toBe('gateway_control');
		expect(GatewayControlDomainSchema.safeParse('worker_control').success).toBe(false);
	});

	it('keeps the gateway operation union exact and separated from worker ops', () => {
		expect([...GatewayControlRpcOperationSchema.options].toSorted()).toEqual([
			'caller_context_register',
			'control_ping',
			'gateway_runtime_readiness',
			'health_event',
			'lease_create',
			'lease_get',
			'lease_peek',
			'lease_reacquire',
			'lease_release',
			'lease_renew',
			'lease_use_end',
			'lease_use_heartbeat',
			'lease_use_start',
			'operation_cancel',
			'recovery_command',
			'runtime_status',
			'tool_portal_admission_reserve',
			'tool_portal_controller_host_action',
			'tool_portal_dispatch_arm',
			'tool_vm_binding_publish',
			'tool_vm_binding_request',
		]);

		expect(GatewayControlRpcOperationSchema.safeParse('git_push').success).toBe(false);
		expect(GatewayControlRpcOperationSchema.safeParse('git_pull_default').success).toBe(false);
		expect(GatewayControlRpcOperationSchema.safeParse('worker_runtime_status').success).toBe(false);
		expect(WorkerControlRpcOperationSchema.safeParse('lease_create').success).toBe(false);
	});

	it('keeps controller-published Tool VM bindings active-use-free and exactly fenced', () => {
		const publication = {
			authority: {
				attachmentGeneration: 3,
				connectionId: '11111111-1111-4111-8111-111111111111',
				controllerEpoch: 'controller-epoch-a',
				gatewayEpoch: 'gateway-epoch-a',
				processEpoch: 'process-epoch-a',
				sessionId: '33333333-3333-4333-8333-333333333333',
				zoneId: 'zone-a',
			},
			binding: {
				agentId: 'agent-a',
				idleTtlMs: 60_000,
				leafGeneration: 'leaf-a',
				leaseId: 'lease-a',
				profileAssignmentRevision: 'assignment-a',
				ssh: {
					host: 'tool-0.vm.host',
					identityPem: 'private-key',
					knownHostsLine: 'tool-0.vm.host ssh-ed25519 AAAA',
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
			observedAtMs: 1_000,
		} as const;
		const publishMessage = GatewayControlRpcMessageSchema.parse({
			kind: 'command',
			operation: 'tool_vm_binding_publish',
			payload: publication,
		});
		const requestMessage = GatewayControlRpcMessageSchema.parse({
			kind: 'command',
			operation: 'tool_vm_binding_request',
			payload: {
				callerContext: { callerContextId: '44444444-4444-4444-8444-444444444444' },
			},
		});

		expect(GatewayControlToolVmBindingPublicationSchema.parse(publication)).toEqual(publication);
		expect(
			GatewayControlToolVmBindingPublicationSchema.safeParse({
				...publication,
				binding: { ...publication.binding, activeUseId: 'use-a' },
			}).success,
		).toBe(false);
		expect(
			GatewayControlRpcMessageSchema.safeParse({
				kind: 'command',
				operation: 'tool_vm_binding_publish',
				payload: publication,
			}).success,
		).toBe(true);
		expect(
			classifyGatewayControlAdmission({
				direction: 'controller_to_gateway',
				message: publishMessage,
			}),
		).toMatchObject({
			messageClass: 'authority',
			stablePrincipal: publication.binding.stablePrincipal,
			status: 'classified',
		});
		expect(
			classifyGatewayControlAdmission({
				direction: 'gateway_to_controller',
				message: publishMessage,
			}),
		).toEqual({ reason: 'direction_violation', status: 'fence' });
		expect(
			classifyGatewayControlAdmission({
				direction: 'gateway_to_controller',
				message: requestMessage,
				stablePrincipal: publication.binding.stablePrincipal,
			}),
		).toMatchObject({ messageClass: 'authority', status: 'classified' });
		expect(
			classifyGatewayControlAdmission({
				direction: 'controller_to_gateway',
				message: requestMessage,
			}),
		).toEqual({ reason: 'direction_violation', status: 'fence' });
	});

	it('carries exact latest-wins Gateway runtime readiness snapshots as events', () => {
		const readiness = createGatewayRuntimeReadinessSnapshot({
			controlEndpoint: {
				identity: {
					bootId: 'boot-1',
					controllerEpoch: 'controller-epoch-1',
					generationId: 'generation-1',
					peerId: 'peer-1',
					processEpoch: 'process-epoch-1',
					zoneId: 'zone-a',
				},
				listener: {
					host: '127.0.0.1',
					port: 18_790,
					readyPath: '/__agent-vm/ready',
					socketPath: '/__agent-vm/gateway-control',
				},
			},
			kind: 'tool-portal-role-readiness',
			providerRevision: 'provider-1',
			requiredBackends: {
				readyBackendKinds: ['mcp_provider'],
				revision: 'bindings-1',
				status: 'ready',
			},
			semanticRevision: 'semantic-1',
			serviceIdentity: {
				processEpoch: 'process-epoch-1',
				role: 'tool-portal',
				serviceId: 'tool-portal-zone-a',
			},
			snapshotVersion: 1,
			uds: {
				attachment: {
					expected: {
						attachmentGeneration: 1,
						clientKind: 'openclaw-managed-plugin',
						configuredAgentIds: ['main'],
						frameworkEpoch: 'framework-epoch-1',
						gatewayEpoch: 'gateway-epoch-1',
						protocolVersion: 1,
						projectionCohortDigest:
							'projection-cohort:0000000000000000000000000000000000000000000000000000000000000000',
						runtimeEpoch: 'runtime-epoch-1',
						schemaVersion: 1,
					},
					observationSequence: 0,
					snapshotVersion: 1,
					status: 'awaiting-attachment',
				},
				publication: {
					identity: 'managed-plugin-private-uds',
					protocolVersion: 1,
					schemaVersion: 1,
					socketPath: '/run/agent-vm/gateway-runtime/managed-plugin.sock',
					status: 'published',
				},
			},
		});
		const message = {
			kind: 'event',
			operation: 'gateway_runtime_readiness',
			payload: readiness,
		} as const;

		expect(GatewayControlRpcMessageSchema.parse(message)).toEqual(message);
		expect(
			GatewayControlRpcMessageSchema.safeParse({
				...message,
				payload: { ...readiness, aggregateReady: true },
			}).success,
		).toBe(false);
		expect(gatewayControlDeliveryPolicyByOperation.gateway_runtime_readiness).toBe('latest_wins');
		expect(
			classifyGatewayControlAdmission({
				direction: 'gateway_to_controller',
				message,
			}),
		).toEqual({
			coalesceKey: 'gateway-runtime-readiness',
			messageClass: 'liveness',
			status: 'classified',
		});
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
					attachmentGeneration: payload.attachmentGeneration,
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
				attachmentGeneration: 1,
				controllerEpoch: gatewayCommandEnvelope.controllerEpoch,
				domain: 'gateway_control',
				gatewayEpoch: 'gateway-epoch-1',
				peerId: gatewayCommandEnvelope.peerId,
				processEpoch: gatewayCommandEnvelope.bootId,
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

	it('allows caller-context registration without invocation-session authority', () => {
		const agentAuthority = {
			algorithm: 'hmac-sha256',
			digest: 'authoritydigestauthoritydigestauthoritydigestauthoritydigest',
			keyId: 'main',
		};
		const validPayload = {
			adapterEvidence: {
				agentAuthority,
				principal: {
					agentId: 'main',
					frameworkIdentity: { agentId: 'main', kind: 'openclaw' },
					profileAssignmentRevision: 'assignment-a',
					toolPortalProfileId: 'engineering',
				},
				proof: {
					algorithm: 'hmac-sha256',
					digest: 'digestdigestdigestdigestdigestdigestdigestdigest',
				},
				zoneId: 'zone-a',
			},
		} as const;

		expect(GatewayControlCallerContextRegisterPayloadSchema.parse(validPayload)).toEqual(
			validPayload,
		);
		expect(
			GatewayControlCallerContextRegisterPayloadSchema.safeParse({
				adapterEvidence: {
					...validPayload.adapterEvidence,
					agentWorkspaceDir: '/home/openclaw/workspace',
				},
			}).success,
		).toBe(false);
		expect(
			GatewayControlCallerContextRegisterPayloadSchema.safeParse({
				adapterEvidence: {
					...validPayload.adapterEvidence,
					workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
				},
			}).success,
		).toBe(false);
		expect(
			GatewayControlCallerContextRegisterPayloadSchema.safeParse({
				adapterEvidence: {
					...validPayload.adapterEvidence,
					sessionKey: 'agent:main:test-session',
				},
			}).success,
		).toBe(false);
		expect(
			GatewayControlCallerContextRegisterPayloadSchema.safeParse({
				adapterEvidence: {
					agentAuthority,
					agentId: 'main',
					agentWorkspaceDir: '/home/openclaw/workspace',
					proof: {
						algorithm: 'hmac-sha256',
						digest: 'digestdigestdigestdigestdigestdigestdigestdigest',
					},
					workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
					zoneId: 'zone-a',
				},
			}).success,
		).toBe(false);
		for (const invalidPrincipal of [
			{
				agentId: 'main',
				frameworkIdentity: { agentId: 'main', kind: 'openclaw' },
				profileAssignmentRevision: 'assignment-a',
			},
			{
				agentId: 'main',
				frameworkIdentity: { agentId: 'main', kind: 'openclaw' },
				profileAssignmentRevision: 'assignment-a',
				toolPortalProfileId: 'engineering',
				unexpectedAuthority: 'forbidden',
			},
		]) {
			expect(
				GatewayControlCallerContextRegisterPayloadSchema.safeParse({
					adapterEvidence: {
						agentAuthority,
						agentWorkspaceDir: '/home/openclaw/workspace',
						principal: invalidPrincipal,
						proof: {
							algorithm: 'hmac-sha256',
							digest: 'digestdigestdigestdigestdigestdigestdigestdigest',
						},
						workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
						zoneId: 'zone-a',
					},
				}).success,
			).toBe(false);
		}
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
						admissionPrincipal: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
						callerContextId: '44444444-4444-4444-8444-444444444444',
					},
					responseToMessageId: '22222222-2222-4222-8222-222222222222',
					result: 'ok',
				},
			}).payload.callerContext,
		).toEqual({
			admissionPrincipal: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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
			idleTtlHintMs: 120_000,
		};

		expect(GatewayControlLeaseCreateIntentPayloadSchema.parse(validPayload)).toEqual(validPayload);

		for (const invalidPayload of [
			{ ...validPayload, gatewayWorkspaceDir: '/workspace/sandbox' },
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

	it('accepts lease reacquire intent fields and rejects plugin-supplied authority', () => {
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
			idleTtlHintMs: 120_000,
			oldLeaseId: '01890f00-0000-7000-8000-000000000001',
			staleEvidence: {
				errorCode: 'ssh-command-failed',
				kind: 'tool-vm-ssh',
				observedAtMs: 1_000,
				operation: 'file-bridge',
			},
		};

		expect(
			GatewayControlRpcMessageSchema.parse({
				kind: 'command',
				operation: 'lease_reacquire',
				payload: validPayload,
			}).payload,
		).toEqual(validPayload);

		for (const invalidPayload of [
			{ ...validPayload, agentId: 'main' },
			{ ...validPayload, profileId: 'standard' },
			{ ...validPayload, hostWorkMountDir: '/Users/example/repo' },
			{ ...validPayload, workMountDir: '/work' },
			{ ...validPayload, sshIdentityPem: '-----BEGIN OPENSSH PRIVATE KEY-----' },
			{ ...validPayload, sessionKey: 'agent:main:test-session' },
		]) {
			expect(
				GatewayControlRpcMessageSchema.safeParse({
					kind: 'command',
					operation: 'lease_reacquire',
					payload: invalidPayload,
				}).success,
			).toBe(false);
		}
	});

	it('roundtrips canonical lease lifecycle rejection reasons', () => {
		expect([...GatewayControlLeaseRejectionReasonSchema.options].toSorted()).toEqual([
			'caller_context_absent',
			'caller_context_session_mismatch',
			'caller_context_stale',
			'lease_absent',
			'lease_authority_absent',
			'lease_force_released',
			'lease_generation_stale',
			'lease_reacquire_required',
			'lease_releasing',
			'lease_retired',
			'lease_use_tombstoned',
			'ownership_denied',
			'runtime_not_ready',
		]);

		for (const rejectionReason of GatewayControlLeaseRejectionReasonSchema.options) {
			expect(GatewayControlLeaseRejectionReasonSchema.parse(rejectionReason)).toBe(rejectionReason);
		}
	});

	it('keeps controller_host_action payload narrow to reviewed host-action intents', () => {
		const validWorkspaceGitPayload = {
			actionId: 'workspace_git_push',
			callerContext: {
				callerContextId: '44444444-4444-4444-8444-444444444444',
			},
			correlation: {
				capability: {
					name: 'workspace_git_push',
					namespace: 'controller_host_action',
				},
				toolCallId: 'tool-call-123',
			},
			expectedHead: '0123456789abcdef0123456789abcdef01234567',
		};
		const validHostProbePayload = {
			actionId: 'controller_host_probe',
			callerContext: {
				callerContextId: '44444444-4444-4444-8444-444444444444',
			},
			correlation: {
				capability: {
					name: 'controller_host_probe',
					namespace: 'controller_host_action',
				},
				toolCallId: 'tool-call-123',
			},
		};

		expect(
			GatewayControlToolPortalControllerHostActionPayloadSchema.parse(validWorkspaceGitPayload),
		).toEqual(validWorkspaceGitPayload);
		expect(
			GatewayControlToolPortalControllerHostActionPayloadSchema.parse(validHostProbePayload),
		).toEqual(validHostProbePayload);

		for (const invalidPayload of [
			{ ...validWorkspaceGitPayload, agentId: 'main' },
			{ ...validWorkspaceGitPayload, argv: ['git', 'push'] },
			{ ...validWorkspaceGitPayload, branch: 'main' },
			{ ...validWorkspaceGitPayload, cwd: '/work' },
			{ ...validWorkspaceGitPayload, env: { GITHUB_TOKEN: 'secret' } },
			{ ...validWorkspaceGitPayload, executablePath: '/usr/bin/git' },
			{ ...validWorkspaceGitPayload, hostWorkMountDir: '/Users/example/repo' },
			{ ...validWorkspaceGitPayload, path: '/workspace' },
			{ ...validWorkspaceGitPayload, remote: 'origin' },
			{ ...validWorkspaceGitPayload, correlation: undefined },
			{ ...validWorkspaceGitPayload, toolPortalAgentId: 'main' },
			{ ...validHostProbePayload, command: 'ls' },
			{ ...validHostProbePayload, expectedHead: '0123456789abcdef0123456789abcdef01234567' },
			{ ...validHostProbePayload, path: '/Users/example' },
			{ ...validHostProbePayload, actionId: 'host_shell_exec' },
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
				leafGeneration: 'leaf-generation-a',
				leaseId: '01890f00-0000-7000-8000-000000000001',
				ssh: {
					host: 'tool-0.vm.host',
					identityPem: 'pem',
					knownHostsLine: 'tool-0.vm.host ssh-ed25519 AAAA',
					port: 22,
					user: 'sandbox',
				},
				sshBindingId: 'ssh-binding-a',
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
			leafGeneration: 'leaf-generation-a',
			leaseId: '01890f00-0000-7000-8000-000000000001',
			ssh: {
				host: 'tool-0.vm.host',
				identityPem: 'pem',
				knownHostsLine: 'tool-0.vm.host ssh-ed25519 AAAA',
				port: 22,
				user: 'sandbox',
			},
			sshBindingId: 'ssh-binding-a',
			state: 'idle',
			tcpSlot: 0,
			transport: 'ssh-sandbox',
			workdir: '/workspace',
			zoneId: 'zone-a',
		});
	});

	it('requires controller-owned leaf and SSH binding identities on private lease snapshots', () => {
		// Arrange
		const privateLeaseSnapshot = {
			agentId: 'main',
			expiresAtMs: 120_000,
			idleTtlMs: 120_000,
			leafGeneration: 'leaf-generation-a',
			leaseId: '01890f00-0000-7000-8000-000000000001',
			ssh: {
				host: 'tool-0.vm.host',
				identityPem: 'pem',
				knownHostsLine: 'tool-0.vm.host ssh-ed25519 AAAA',
				port: 22,
				user: 'sandbox',
			},
			sshBindingId: 'ssh-binding-a',
			state: 'idle' as const,
			tcpSlot: 0,
			transport: 'ssh-sandbox' as const,
			workdir: '/workspace',
			zoneId: 'zone-a',
		};

		// Act
		const parsedPrivateLease = GatewayControlPrivateLeaseSnapshotSchema.parse(privateLeaseSnapshot);
		const missingLeafGeneration = GatewayControlPrivateLeaseSnapshotSchema.safeParse(
			Object.fromEntries(
				Object.entries(privateLeaseSnapshot).filter(([key]) => key !== 'leafGeneration'),
			),
		);
		const missingSshBindingId = GatewayControlPrivateLeaseSnapshotSchema.safeParse(
			Object.fromEntries(
				Object.entries(privateLeaseSnapshot).filter(([key]) => key !== 'sshBindingId'),
			),
		);

		// Assert
		expect(parsedPrivateLease).toEqual(privateLeaseSnapshot);
		expect(missingLeafGeneration.success).toBe(false);
		expect(missingSshBindingId.success).toBe(false);
	});

	it('rejects private lease authority on public lease response operations', () => {
		// Arrange
		const privateLeaseResult = {
			kind: 'command_result' as const,
			payload: {
				lease: {
					agentId: 'main',
					idleTtlMs: 120_000,
					leafGeneration: 'leaf-generation-a',
					leaseId: '01890f00-0000-7000-8000-000000000001',
					ssh: {
						host: 'tool-0.vm.host',
						identityPem: 'pem',
						knownHostsLine: 'tool-0.vm.host ssh-ed25519 AAAA',
						port: 22,
						user: 'sandbox',
					},
					sshBindingId: 'ssh-binding-a',
					state: 'idle' as const,
					tcpSlot: 0,
					transport: 'ssh-sandbox' as const,
					workdir: '/workspace',
					zoneId: 'zone-a',
				},
				responseToMessageId: '44444444-4444-4444-8444-444444444444',
				result: 'ok' as const,
			},
		};
		const rootAuthorityLeaseResult = structuredClone(privateLeaseResult);
		Reflect.deleteProperty(rootAuthorityLeaseResult.payload.lease.ssh, 'identityPem');
		Reflect.deleteProperty(rootAuthorityLeaseResult.payload.lease.ssh, 'knownHostsLine');
		const sshAuthorityLeaseResult = structuredClone(privateLeaseResult);
		Reflect.deleteProperty(sshAuthorityLeaseResult.payload.lease, 'leafGeneration');
		Reflect.deleteProperty(sshAuthorityLeaseResult.payload.lease, 'sshBindingId');

		// Act
		const privateRead = GatewayControlRpcCommandResultMessageSchema.safeParse({
			...privateLeaseResult,
			operation: 'lease_get',
		});
		const publicPeek = GatewayControlRpcCommandResultMessageSchema.safeParse({
			...rootAuthorityLeaseResult,
			operation: 'lease_peek',
		});
		const publicRelease = GatewayControlRpcCommandResultMessageSchema.safeParse({
			...sshAuthorityLeaseResult,
			operation: 'lease_release',
		});

		// Assert
		expect(privateRead.success).toBe(true);
		expect(publicPeek.success).toBe(false);
		expect(publicRelease.success).toBe(false);
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
			GatewayControlRpcMessageSchema.safeParse({
				kind: 'event',
				operation: 'health_event',
				payload: {
					activeUseId: '66666666-6666-4666-8666-666666666666',
					agentId: 'main',
					callerContextState: 'stale',
					elapsedMs: 25,
					errorCode: 'ssh-command-failed',
					eventKind: 'tool-vm-ssh',
					leaseId: '01890f00-0000-7000-8000-000000000001',
					leaseRejectionReason: 'caller_context_stale',
					lifecycleEventRole: 'plugin_observation',
					lifecycleTransition: 'current_to_stale',
					observedAtMs: 1,
					oldLeaseId: '01890f00-0000-7000-8000-000000000001',
					operation: 'file-bridge',
					result: 'failed',
					transitionId: '77777777-7777-4777-8777-777777777777',
				},
			}).success,
		).toBe(true);

		expect(
			GatewayControlRpcMessageSchema.safeParse({
				kind: 'event',
				operation: 'health_event',
				payload: {
					activeUseId: '66666666-6666-4666-8666-666666666666',
					agentId: 'main',
					callerContextState: 'stale',
					elapsedMs: 25,
					errorCode: 'ssh-command-failed',
					eventKind: 'tool-vm-ssh',
					leaseId: '01890f00-0000-7000-8000-000000000001',
					leaseRejectionReason: 'caller_context_stale',
					lifecycleEventRole: 'controller_final',
					lifecycleTransition: 'stale_to_reacquired',
					observedAtMs: 1,
					oldLeaseId: '01890f00-0000-7000-8000-000000000001',
					operation: 'file-bridge',
					replacementLeaseId: '01890f00-0000-7000-8000-000000000002',
					result: 'ok',
					transitionId: '77777777-7777-4777-8777-777777777777',
				},
			}).success,
		).toBe(false);

		expect(
			GatewayControlHealthEventPayloadSchema.safeParse({
				activeUseId: '66666666-6666-4666-8666-666666666666',
				agentId: 'main',
				callerContextState: 'stale',
				elapsedMs: 25,
				eventKind: 'tool-vm-ssh',
				leaseId: '01890f00-0000-7000-8000-000000000001',
				leaseRejectionReason: 'caller_context_stale',
				lifecycleEventRole: 'plugin_observation',
				observedAtMs: 1,
				oldLeaseId: '01890f00-0000-7000-8000-000000000001',
				operation: 'file-bridge',
				result: 'failed',
				transitionId: '77777777-7777-4777-8777-777777777777',
			}).success,
		).toBe(false);

		expect(
			GatewayControlHealthEventPayloadSchema.safeParse({
				activeUseId: '66666666-6666-4666-8666-666666666666',
				agentId: 'main',
				callerContextState: 'ok',
				elapsedMs: 25,
				eventKind: 'tool-vm-ssh',
				leaseId: '01890f00-0000-7000-8000-000000000002',
				lifecycleEventRole: 'plugin_observation',
				lifecycleTransition: 'stale_to_reacquired',
				observedAtMs: 1,
				oldLeaseId: '01890f00-0000-7000-8000-000000000001',
				operation: 'file-bridge',
				result: 'ok',
				transitionId: '77777777-7777-4777-8777-777777777777',
			}).success,
		).toBe(false);

		expect(
			GatewayControlHealthEventPayloadSchema.safeParse({
				activeUseId: '66666666-6666-4666-8666-666666666666',
				agentId: 'main',
				callerContextState: 'stale',
				elapsedMs: 25,
				eventKind: 'tool-vm-ssh',
				leaseId: '01890f00-0000-7000-8000-000000000001',
				leaseRejectionReason: 'caller_context_stale',
				lifecycleEventRole: 'operator_guess',
				lifecycleTransition: 'stale_to_reacquired',
				observedAtMs: 1,
				oldLeaseId: '01890f00-0000-7000-8000-000000000001',
				operation: 'file-bridge',
				replacementLeaseId: '01890f00-0000-7000-8000-000000000002',
				result: 'ok',
				transitionId: '77777777-7777-4777-8777-777777777777',
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
						actionId: 'workspace_git_push',
						result: {
							branch: 'main',
							localHead: '0123456789abcdef0123456789abcdef01234567',
							pushedCommits: [
								{ sha: '0123456789abcdef0123456789abcdef01234567', subject: 'docs: update memory' },
							],
							remoteHead: '0123456789abcdef0123456789abcdef01234567',
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
			leafGeneration: 'leaf-generation-a',
			leaseId: '01890f00-0000-7000-8000-000000000001',
			ssh: {
				host: 'tool-0.vm.host',
				identityPem: 'pem',
				knownHostsLine: 'tool-0.vm.host ssh-ed25519 AAAA',
				port: 22,
				user: 'sandbox',
			},
			sshBindingId: 'ssh-binding-a',
			state: 'idle',
			tcpSlot: 0,
			transport: 'ssh-sandbox',
			workdir: '/workspace',
			zoneId: 'zone-a',
		};

		const controllerHostActionResult = {
			actionId: 'workspace_git_push',
			result: {
				branch: 'main',
				localHead: '0123456789abcdef0123456789abcdef01234567',
				pushedCommits: [
					{ sha: '0123456789abcdef0123456789abcdef01234567', subject: 'docs: update memory' },
				],
				remoteHead: '0123456789abcdef0123456789abcdef01234567',
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
				operation: 'lease_reacquire',
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
				operation: 'lease_reacquire',
				payload: {
					leaseRejectionReason: 'lease_authority_absent',
					responseToMessageId: '22222222-2222-4222-8222-222222222222',
					result: 'rejected',
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

	it('binds command_result success fields to successful gateway results', () => {
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
			actionId: 'workspace_git_push',
			result: {
				branch: 'main',
				localHead: '0123456789abcdef0123456789abcdef01234567',
				pushedCommits: [
					{ sha: '0123456789abcdef0123456789abcdef01234567', subject: 'docs: update memory' },
				],
				remoteHead: '0123456789abcdef0123456789abcdef01234567',
			},
		};

		expect(
			GatewayControlRpcCommandResultMessageSchema.safeParse({
				kind: 'command_result',
				operation: 'lease_create',
				payload: {
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
					lease: leaseResult,
					leaseRejectionReason: 'lease_absent',
					responseToMessageId: '22222222-2222-4222-8222-222222222222',
					result: 'rejected',
				},
			}).success,
		).toBe(false);

		expect(
			GatewayControlRpcCommandResultMessageSchema.safeParse({
				kind: 'command_result',
				operation: 'tool_portal_controller_host_action',
				payload: {
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
					error: {
						errorClass: 'controller_host_action_denied',
						retryable: false,
						safeMessage: 'controller host action denied',
					},
					responseToMessageId: '22222222-2222-4222-8222-222222222222',
					result: 'rejected',
				},
			}).success,
		).toBe(false);
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

	it('derives lease_create as single-use when idempotency material is absent', () => {
		const leaseCreateWithoutIdempotency = ControlEnvelopeSchema.parse({
			...gatewayCommandEnvelope,
			deliveryPolicy: 'single_use_critical',
			idempotencyKey: undefined,
		});

		expect(deriveGatewayControlDeliveryPolicy(leaseCreateWithoutIdempotency)).toBe(
			'single_use_critical',
		);
		expect(() =>
			assertGatewayControlEnvelopeDeliveryPolicy({
				...leaseCreateWithoutIdempotency,
				deliveryPolicy: 'critical_idempotent',
			}),
		).toThrow(/delivery policy mismatch/u);
	});
});
