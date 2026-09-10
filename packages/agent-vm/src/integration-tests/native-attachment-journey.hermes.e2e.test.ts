import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { PortalAttachmentResult } from '@agent-vm/agent-portal-sdk';
import { GatewayStablePrincipalDigestSchema } from '@agent-vm/agent-portal-sdk/contracts';
import {
	deriveGatewayControlStablePrincipal,
	GatewayControlRpcCommandResultMessageSchema,
} from '@agent-vm/gateway-control-contracts';
import { afterEach, describe, expect, it } from 'vitest';

import type { GatewayRuntimeControlCommandClient } from '../../../gateway-runtime/src/control-endpoint/gateway-control-command-client.js';
import { createGatewayControlNativeAttachmentPort } from '../../../gateway-runtime/src/native-attachment-gateway-control-port.js';
import { createGatewayRuntimePrivateUdsDispatcher } from '../../../gateway-runtime/src/production/gateway-runtime-private-uds-dispatcher.js';
import { createControllerSharedStaging } from '../controller/files/controller-shared-staging.js';
import type { ToolVmWorkFileLeaseManager } from '../controller/files/current-tool-vm-work-files.js';
import { accessNativeAttachment } from '../controller/files/native-attachment-controller-access.js';
import { createNativeAttachmentStaging } from '../controller/files/native-attachment-staging.js';
import { createOperationFileRetentionBudget } from '../controller/files/operation-file-retention-budget.js';
import { prepareGogRealFsLeaseFixture } from '../controller/oauth/gog-realfs-authority.integration-test-fixture.js';

const executeFile = promisify(execFile);
const hermesRuntimeImage =
	'docker.io/nousresearch/hermes-agent@sha256:e0df6adebddf29b91112aefc999d4aaf6846c9eb544faca5672a16a13590ff79';
const temporaryRoots: string[] = [];
// Expected bytes live in this test process; Gateway payload memory is measured independently in Python.
const selectedBytes = Buffer.alloc(
	8 * 1024 * 1024,
	Buffer.from('fake-google/gog-export\u0000with-binary\u0001bytes', 'utf8'),
);
const selectedDigest = createHash('sha256').update(selectedBytes).digest('hex');

interface GatewayRuntimeCallback {
	readonly method: string;
	readonly params: {
		readonly publicRequest: Record<string, unknown>;
		readonly trustedContext: {
			readonly correlation?: { readonly sessionId?: string };
			readonly principal?: {
				readonly agentId?: string;
				readonly frameworkIdentity?: { readonly profileName?: string };
			};
		};
	};
}

const callerContextId = '10000000-0000-4000-8000-000000000001';

async function readJsonRequest(request: IncomingMessage): Promise<GatewayRuntimeCallback> {
	const chunks: Buffer[] = [];
	let byteLength = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		byteLength += bytes.byteLength;
		if (byteLength > 64 * 1024) throw new Error('Native attachment callback exceeded 64 KiB.');
		chunks.push(bytes);
	}
	return JSON.parse(Buffer.concat(chunks).toString('utf8')) as GatewayRuntimeCallback;
}

function writeJsonResponse(response: ServerResponse, value: unknown): void {
	response.writeHead(200, { 'content-type': 'application/json' });
	response.end(JSON.stringify(value));
}

async function rejectUnexpectedPrivateOperation(): Promise<never> {
	throw new Error('Journey dispatched an unexpected private operation.');
}

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
	);
});

describe('native attachment full host-cache journey', () => {
	it.each([
		{
			expectedCallbackActions: ['stage', 'settle'],
			expectedCleanup: 'complete',
			expectedKind: 'attached',
			expectedSenderCount: 1,
			expectedSettlement: 'sent',
			senderOutcome: 'sent',
		},
		{
			expectedCallbackActions: ['stage', 'settle'],
			expectedCleanup: 'complete',
			expectedKind: 'attachment-unconfirmed',
			expectedSenderCount: 1,
			expectedSettlement: 'unconfirmed',
			senderOutcome: 'failed',
		},
		{
			expectedCallbackActions: ['stage', 'settle'],
			expectedCleanup: 'complete',
			expectedKind: 'attachment-unconfirmed',
			expectedSenderCount: 1,
			expectedSettlement: 'unconfirmed',
			senderOutcome: 'missing-message-id',
		},
		{
			expectedCallbackActions: ['stage'],
			expectedCleanup: 'pending',
			expectedKind: 'attachment-failed',
			expectedSenderCount: 0,
			expectedSettlement: undefined,
			senderOutcome: 'stale-generation',
		},
		{
			expectedCallbackActions: ['stage', 'settle'],
			expectedCleanup: 'complete',
			expectedKind: 'attachment-failed',
			expectedSenderCount: 0,
			expectedSettlement: 'failed',
			senderOutcome: 'route-replaced',
		},
	] as const)(
		'runs the actual plugin through the $senderOutcome controller-access boundary',
		async ({
			expectedCallbackActions,
			expectedCleanup,
			expectedKind,
			expectedSenderCount,
			expectedSettlement,
			senderOutcome,
		}) => {
			// Arrange: Google/Gog and the VM provider are explicit local substitutes. The
			// shared publication, lease owner, controller access, sender and cleanup are real.
			const root = await mkdtemp(path.join(tmpdir(), 'native-attachment-journey-'));
			temporaryRoots.push(root);
			const cacheDirectory = path.join(root, 'gateway-cache');
			await mkdir(cacheDirectory);
			await writeFile(path.join(cacheDirectory, 'ordinary-cache-sentinel'), 'preserve');
			const retentionBudget = createOperationFileRetentionBudget();
			const sharedStagingController = createControllerSharedStaging({
				controllerEpoch: 'controller-realfs',
				controllerRuntimeDir: path.join(root, 'runtime'),
				now: () => 1_000,
				retentionBudget,
			});
			const principal = {
				agentId: 'sun',
				frameworkIdentity: { kind: 'hermes', profileName: 'sun' },
				profileAssignmentRevision: 'revision-sun',
				toolPortalProfileId: 'policy-sun',
			} as const;
			const sharedStaging = await sharedStagingController.getStore('zone', principal.agentId);
			const leaseFixture = await prepareGogRealFsLeaseFixture({
				principal,
				root,
				sharedStaging: sharedStagingController,
				zoneId: 'zone',
			});
			const operationDirectory = await sharedStaging.prepareOperation({
				maximumBytes: selectedBytes.byteLength,
				operationId: 'fake-google-operation',
				producerId: 'fake-google-gog',
			});
			await writeFile(path.join(operationDirectory, 'fake-google-export.bin'), selectedBytes);
			const publication = await sharedStaging.publish({
				operationId: 'fake-google-operation',
				producerId: 'fake-google-gog',
				receiver: leaseFixture.receiver,
				relativePaths: ['fake-google-export.bin'],
				signal: new AbortController().signal,
				withPublicationAuthority: async (expose) => await expose(),
			});
			expect(publication.files).toMatchObject([
				{ byteLength: selectedBytes.byteLength, sha256: selectedDigest },
			]);
			const staging = createNativeAttachmentStaging({
				retentionBudget,
			});
			const callerContext = {
				agentId: 'sun',
				bootId: leaseFixture.authority.gateway.bootId,
				callerContextId,
				connectionId: 'private-control-connection',
				controllerEpoch: leaseFixture.authority.gateway.controllerEpoch,
				peerId: 'gateway-peer',
				principal,
				purpose: 'tool_portal_controller_execution' as const,
				sessionId: 'private-control-session',
				stablePrincipal: deriveGatewayControlStablePrincipal({ principal }),
				zoneId: 'zone',
			};
			const accessLeaseManager: ToolVmWorkFileLeaseManager = {
				endActiveUse: leaseFixture.leaseManager.endActiveUse.bind(leaseFixture.leaseManager),
				getCurrentLeaseBinding: (leaseId) => {
					const binding = leaseFixture.leaseManager.getCurrentLeaseBinding(leaseId);
					return senderOutcome === 'stale-generation' && binding !== undefined
						? { ...binding, leafGeneration: 'stale-leaf-generation' }
						: binding;
				},
				getLeaseAuthority: leaseFixture.leaseManager.getLeaseAuthority.bind(
					leaseFixture.leaseManager,
				),
				heartbeatActiveUse: leaseFixture.leaseManager.heartbeatActiveUse.bind(
					leaseFixture.leaseManager,
				),
				listLeases: leaseFixture.leaseManager.listLeases.bind(leaseFixture.leaseManager),
				startActiveUse: leaseFixture.leaseManager.startActiveUse.bind(leaseFixture.leaseManager),
				subscribeLeaseRetirement: leaseFixture.leaseManager.subscribeLeaseRetirement.bind(
					leaseFixture.leaseManager,
				),
			};
			const callbackRequests: GatewayRuntimeCallback[] = [];
			const registeredTrustedContexts: unknown[] = [];
			const dispatchedConnections: string[] = [];
			let stagedHostPath: string | undefined;
			const sendCommand: GatewayRuntimeControlCommandClient['sendCommand'] = async (request) => {
				if (request.message.operation !== 'tool_portal_attachment')
					throw new Error('Journey issued an unexpected controller operation.');
				expect(request.admissionPrincipal).toBe('a'.repeat(64));
				const { request: portalRequest, sessionId } = request.message.payload;
				expect(sessionId).toBe('captured-session');
				if (portalRequest.action === 'stage') {
					expect(portalRequest.source).toEqual({
						kind: 'operation-file',
						path: 'fake-google-export.bin',
						referenceId: publication.publicationId,
					});
				} else {
					expect(portalRequest).toMatchObject({
						action: 'settle',
						outcome: expectedSettlement,
					});
					if (stagedHostPath === undefined) throw new Error('Settlement arrived before staging.');
					expect((await readFile(stagedHostPath)).equals(selectedBytes)).toBe(true);
				}
				const nativeAttachment: PortalAttachmentResult = await accessNativeAttachment({
					cacheDirectory,
					context: {
						callerContext,
						executionProof: {
							operationPayloadDigest: 'native-attachment-payload',
							processEpoch: 'native-attachment-process',
							semanticOperationId: `native-attachment-${portalRequest.action}`,
							sessionAttachmentGeneration: 1,
						},
						gateway: leaseFixture.authority.gateway,
						request: portalRequest,
						sessionId,
						signal: new AbortController().signal,
					},
					destinationAuthorityIsCurrent: () => true,
					destinationVm: { id: leaseFixture.authority.gateway.gatewayVmId },
					leaseManager: accessLeaseManager,
					sharedStaging,
					staging,
				});
				if (portalRequest.action === 'stage' && nativeAttachment.kind === 'staged') {
					stagedHostPath = path.join(
						cacheDirectory,
						nativeAttachment.path.slice('/home/hermes/.cache/'.length),
					);
					expect((await readFile(stagedHostPath)).equals(selectedBytes)).toBe(true);
				}
				const messageId =
					portalRequest.action === 'stage'
						? '20000000-0000-4000-8000-000000000002'
						: '30000000-0000-4000-8000-000000000003';
				return {
					acceptedSession: {
						attachmentGeneration: 1,
						bootId: 'boot',
						connectionId: 'private-control-connection',
						controllerEpoch: 'controller-run',
						gatewayEpoch: 'gateway-epoch',
						generationId: 'gateway-generation',
						peerId: 'gateway-peer',
						processEpoch: 'framework-epoch',
						sessionId: 'private-control-session',
						zoneId: 'zone',
					},
					messageId,
					response: GatewayControlRpcCommandResultMessageSchema.parse({
						kind: 'command_result',
						operation: 'tool_portal_attachment',
						payload: { nativeAttachment, responseToMessageId: messageId, result: 'ok' },
					}),
				};
			};
			const attachmentOperations = createGatewayControlNativeAttachmentPort({
				callerContextRegistrationClient: {
					close: async () => {},
					register: async ({ trustedContext }) => {
						registeredTrustedContexts.push(trustedContext);
						return {
							admissionPrincipal: GatewayStablePrincipalDigestSchema.parse('a'.repeat(64)),
							callerContextId,
						};
					},
				},
				controlCommandClient: { sendCommand },
				now: () => 1000,
			});
			const dispatcher = createGatewayRuntimePrivateUdsDispatcher({
				approvalOperations: { decide: rejectUnexpectedPrivateOperation },
				artifactOperations: { read: rejectUnexpectedPrivateOperation },
				attachmentOperations,
				portalOperations: {
					call: rejectUnexpectedPrivateOperation,
					describe: rejectUnexpectedPrivateOperation,
					list: rejectUnexpectedPrivateOperation,
					search: rejectUnexpectedPrivateOperation,
				},
				sandboxDispatch: rejectUnexpectedPrivateOperation,
				traceContextDispatch: async ({ connectionId }, dispatch) => {
					dispatchedConnections.push(connectionId);
					return await dispatch();
				},
			});
			const callbackToken = randomBytes(32).toString('base64url');
			const server = createServer((request, response) => {
				void (async () => {
					try {
						if (request.headers.authorization !== `Bearer ${callbackToken}`) {
							response.writeHead(401);
							response.end();
							return;
						}
						const callback = await readJsonRequest(request);
						callbackRequests.push(callback);
						writeJsonResponse(
							response,
							await dispatcher.dispatch({
								connectionId: 'private-uds-fixture-connection',
								method: callback.method,
								params: callback.params,
								signal: new AbortController().signal,
							}),
						);
					} catch (error) {
						response.writeHead(500, { 'content-type': 'text/plain' });
						response.end(error instanceof Error ? error.stack : String(error));
					}
				})();
			});
			await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
			const address = server.address();
			if (address === null || typeof address === 'string')
				throw new Error('Missing callback port.');
			try {
				const unauthorized = await fetch(`http://127.0.0.1:${address.port}`, {
					body: '{}',
					headers: { 'content-type': 'application/json' },
					method: 'POST',
				});
				expect(unauthorized.status).toBe(401);
				// Act
				const result = await executeFile(
					'docker',
					[
						'run',
						'--rm',
						'--add-host',
						'host.docker.internal:host-gateway',
						'--entrypoint',
						'/opt/hermes/.venv/bin/python',
						'--env',
						'PYTHONDONTWRITEBYTECODE=1',
						'--env',
						'PYTHONPATH=/workspace/python/agent-vm-hermes-adapter/src:/workspace/python/agent-vm-agent-portal-sdk/src',
						'--env',
						`AGENT_VM_NATIVE_ATTACHMENT_CALLBACK_URL=http://host.docker.internal:${address.port}`,
						'--env',
						`AGENT_VM_NATIVE_ATTACHMENT_CALLBACK_TOKEN=${callbackToken}`,
						'--env',
						`AGENT_VM_NATIVE_ATTACHMENT_REFERENCE_ID=${publication.publicationId}`,
						'--env',
						`AGENT_VM_NATIVE_ATTACHMENT_SENDER_OUTCOME=${senderOutcome}`,
						'--env',
						'AGENT_VM_NATIVE_ATTACHMENT_CACHE_DIR=/home/hermes/.cache',
						'--mount',
						`type=bind,source=${process.cwd()},target=/workspace,readonly`,
						'--mount',
						`type=bind,source=${cacheDirectory},target=/home/hermes/.cache`,
						'--workdir',
						'/workspace',
						hermesRuntimeImage,
						'/workspace/python/agent-vm-hermes-adapter/tests/native_attachment_journey_fixture.py',
					],
					{
						maxBuffer: 128 * 1024,
						timeout: 60_000,
					},
				);
				const journey = JSON.parse(result.stdout) as {
					readonly result: Record<string, unknown>;
					readonly senderCalls: readonly Record<string, unknown>[];
					readonly memory: {
						readonly peakBytes: number;
						readonly stalledReadBytes: number;
					};
				};

				// Assert: the recording sender saw the exact selected cache bytes, and its
				// settled result caused the controller owner to delete only the send child.
				expect(journey.result).toMatchObject({
					cleanup: expectedCleanup,
					kind: expectedKind,
				});
				expect(journey).toMatchObject({ memory: { peakBytes: expect.any(Number) } });
				expect(journey.memory.peakBytes).toBeLessThan(2 * 1024 * 1024);
				expect(journey.memory.stalledReadBytes).toBe(expectedSenderCount === 0 ? 0 : 64 * 1024);
				process.stdout.write(`[native-gateway-memory] ${JSON.stringify(journey.memory)}\n`);
				if (expectedKind === 'attached') {
					expect(journey.result).toMatchObject({
						byteLength: selectedBytes.byteLength,
						messageId: 'recording-native-message',
						sha256: selectedDigest,
					});
				} else if (expectedKind === 'attachment-unconfirmed') {
					expect(journey.result).toMatchObject({ reason: 'send-error' });
					expect(journey.result).not.toHaveProperty('byteLength');
					expect(journey.result).not.toHaveProperty('messageId');
				} else {
					expect(journey.result).toMatchObject({
						reason: senderOutcome === 'stale-generation' ? 'staging-failed' : 'route-unavailable',
					});
				}
				expect(journey.senderCalls).toEqual(
					expectedSenderCount === 0
						? []
						: [
								{
									byteLength: selectedBytes.byteLength,
									caption: 'Fake Google export',
									fileName: 'fake-google-export.bin',
									sha256: selectedDigest,
								},
							],
				);
				expect(callbackRequests.map(({ params }) => params.publicRequest.action)).toEqual(
					expectedCallbackActions,
				);
				expect(registeredTrustedContexts).toHaveLength(expectedCallbackActions.length);
				for (const context of registeredTrustedContexts) {
					expect(context).toEqual(
						expect.objectContaining({
							correlation: { sessionId: 'captured-session' },
							principal: expect.objectContaining({
								agentId: 'sun',
								frameworkIdentity: { kind: 'hermes', profileName: 'sun' },
							}),
						}),
					);
				}
				expect(dispatchedConnections).toEqual(
					expectedCallbackActions.map(() => 'private-uds-fixture-connection'),
				);
				if (stagedHostPath === undefined) {
					expect(senderOutcome).toBe('stale-generation');
				} else {
					await expect(readFile(stagedHostPath)).rejects.toMatchObject({ code: 'ENOENT' });
				}
				expect(await readFile(path.join(cacheDirectory, 'ordinary-cache-sentinel'), 'utf8')).toBe(
					'preserve',
				);
			} finally {
				await Promise.all([
					new Promise<void>((resolve, reject) =>
						server.close((error) => (error === undefined ? resolve() : reject(error))),
					),
					leaseFixture.close(),
				]);
			}
		},
	);
});
