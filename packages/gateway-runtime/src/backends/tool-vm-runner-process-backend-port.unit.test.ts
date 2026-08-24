import {
	PortalCallResultSchema,
	type ArtifactReference,
	type JsonObject,
	type PortalCallResult,
	type SandboxProcessHandle,
	type SandboxProcessLogsResult,
	type SandboxProcessStartResult,
} from '@agent-vm/agent-portal-sdk';
import {
	createGatewayRuntimeManagedToolPortalConfig,
	effectiveManagedToolPortalConfigSchema,
} from '@agent-vm/config-contracts';
import {
	deriveGatewayControlStablePrincipal,
	type GatewayRuntimeTrustedInvocationContext,
} from '@agent-vm/gateway-control-contracts';
import type { ToolPortalBackendCallOptions } from '@agent-vm/tool-portal';
import { describe, expect, it, vi } from 'vitest';

import { createGatewayRuntimeSandboxOperationAuthority } from '../sandbox/sandbox-operation-authority.js';
import type { GatewayRuntimeSandboxProcessRegistry } from '../sandbox/sandbox-process-registry.js';
import type { StrictToolVmSshClient } from '../sandbox/strict-tool-vm-ssh-client.js';
import { StrictToolVmSshProcessStartError } from '../sandbox/strict-tool-vm-ssh-process-runtime.js';
import {
	MAXIMUM_TOOL_VM_RUNNER_PROCESS_LOG_BYTES,
	createGatewayRuntimeToolVmRunnerBackendPort,
	type GatewayRuntimeToolVmRunnerArtifactWriteRequest,
	type GatewayRuntimeToolVmRunnerBackendPort,
	type GatewayRuntimeToolVmRunnerCapabilityCatalog,
	type GatewayRuntimeToolVmRunnerSandboxBindingRequest,
} from './tool-vm-runner-backend-port.js';
import { compileGatewayRuntimeToolVmRunnerConfiguredCatalog } from './tool-vm-runner-configured-catalog.js';

const trustedContext = {
	correlation: { runId: 'run-a', sessionId: 'session-a', toolCallId: 'tool-call-a' },
	principal: {
		agentId: 'agent-a',
		frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
		profileAssignmentRevision: 'profile-assignment:agent-a:7',
		toolPortalProfileId: 'code-builder',
	},
	requester: { authenticatedSubjectId: 'subject-a' },
} as const satisfies GatewayRuntimeTrustedInvocationContext;

const operationContext = {
	activeUseId: 'active-use-7',
	environmentGeneration: 'environment-generation-7',
	gatewayEpoch: 'gateway-epoch-7',
	leafGeneration: 'leaf-generation-7',
	leaseId: 'lease-7',
	sshBindingId: 'ssh-binding-7',
	stablePrincipal: deriveGatewayControlStablePrincipal({ principal: trustedContext.principal }),
} as const;

const operation = {
	operationId: 'canonical-process-operation-7',
	owningGeneration: operationContext.environmentGeneration,
} as const;
const process = {
	handleId: 'canonical-process-handle-7',
	kind: 'process',
	owningGeneration: operationContext.environmentGeneration,
} as const;
const streams = [
	{
		channel: 'stdin',
		handleId: 'canonical-stdin-7',
		kind: 'stream',
		owningGeneration: operationContext.environmentGeneration,
	},
	{
		channel: 'stdout',
		handleId: 'canonical-stdout-7',
		kind: 'stream',
		owningGeneration: operationContext.environmentGeneration,
	},
	{
		channel: 'stderr',
		handleId: 'canonical-stderr-7',
		kind: 'stream',
		owningGeneration: operationContext.environmentGeneration,
	},
] as const;

function processCatalog(): GatewayRuntimeToolVmRunnerCapabilityCatalog {
	const config = effectiveManagedToolPortalConfigSchema.parse({
		agents: { 'agent-a': { profile: 'code-builder' } },
		mode: 'managed',
		profiles: {
			'code-builder': {
				namespaces: {
					sandbox: {
						discovery: {},
						backend: {
							kind: 'tool_vm_runner',
							operations: {
								process_cancel: {
									description: 'Cancel one process.',
									kind: 'process.cancel',
								},
								process_logs: {
									description: 'Read process logs.',
									kind: 'process.logs',
								},
								process_start: {
									description: 'Start the configured watcher.',
									executable: '/usr/bin/watch-build',
									kind: 'process.start',
									mandatoryArgvPrefix: ['--fixed'],
									maxRuntimeMs: 30_000,
									retainOutputBytes: 4_096,
									workingDirectory: 'repo',
								},
								process_status: {
									description: 'Read process status.',
									kind: 'process.status',
								},
								process_wait: {
									description: 'Wait for process completion.',
									kind: 'process.wait',
									timeoutMs: 500,
								},
							},
							profile: 'sandbox_ssh',
						},
						calls: {
							requiresApproval: { allow: [], deny: [] },
							withoutApproval: { allow: '*', deny: [] },
						},
						tools: { allow: '*', deny: [] },
					},
				},
			},
		},
		schemaVersion: 1,
	});
	return compileGatewayRuntimeToolVmRunnerConfiguredCatalog(
		createGatewayRuntimeManagedToolPortalConfig(config),
	);
}

interface ProcessFixtureOptions {
	readonly logsExceedRequestedBound?: boolean;
	readonly startError?: StrictToolVmSshProcessStartError;
}

interface ProcessFixture {
	readonly artifactWrites: GatewayRuntimeToolVmRunnerArtifactWriteRequest[];
	readonly bindingRequests: GatewayRuntimeToolVmRunnerSandboxBindingRequest[];
	readonly cancel: ReturnType<typeof vi.fn>;
	readonly endActiveUse: ReturnType<typeof vi.fn>;
	readonly logs: ReturnType<typeof vi.fn>;
	readonly operationAuthority: ReturnType<typeof createGatewayRuntimeSandboxOperationAuthority>;
	readonly port: GatewayRuntimeToolVmRunnerBackendPort;
	readonly retireGroup: ReturnType<typeof vi.fn>;
	readonly start: ReturnType<typeof vi.fn>;
	readonly status: ReturnType<typeof vi.fn>;
	readonly wait: ReturnType<typeof vi.fn>;
}

function artifactReferenceFor(
	request: GatewayRuntimeToolVmRunnerArtifactWriteRequest,
): ArtifactReference {
	return {
		byteLength: request.bytes.byteLength,
		expiresAt: '2026-07-17T20:00:00.000Z',
		fingerprint: `sha256:${(request.role === 'stderr' ? 'b' : 'a').repeat(64)}`,
		id: `${request.operationId}-${request.role}`,
		mediaType: request.mediaType,
	};
}

function createProcessFixture(options: ProcessFixtureOptions = {}): ProcessFixture {
	const artifactWrites: GatewayRuntimeToolVmRunnerArtifactWriteRequest[] = [];
	const bindingRequests: GatewayRuntimeToolVmRunnerSandboxBindingRequest[] = [];
	const operationAuthority = createGatewayRuntimeSandboxOperationAuthority(operationContext);
	let nextProcessNumber = 0;
	const start = vi.fn(async (): Promise<SandboxProcessStartResult> => {
		if (options.startError !== undefined) throw options.startError;
		const processNumber = nextProcessNumber++;
		const startedProcess =
			processNumber === 0
				? process
				: { ...process, handleId: `${process.handleId}-${String(processNumber)}` };
		return { kind: 'started', operation, process: startedProcess, streams: [...streams] };
	});
	const status = vi.fn(
		(request: { readonly process: SandboxProcessHandle }) =>
			({ kind: 'running', operation, process: request.process }) as const,
	);
	const wait = vi.fn(
		async (request: { readonly process: SandboxProcessHandle }) =>
			({
				kind: 'terminal',
				operation,
				outcome: {
					certainty: 'proven',
					completion: 'succeeded',
					kind: 'completed',
					retryClass: 'forbidden',
				},
				process: request.process,
			}) as const,
	);
	const cancel = vi.fn(() => ({ kind: 'cancel-request-accepted', operation }) as const);
	const logs = vi.fn(
		(request: { readonly process: SandboxProcessHandle }): SandboxProcessLogsResult => ({
			chunks: [
				{
					channel: 'stdout',
					chunk: {
						byteLength: options.logsExceedRequestedBound === true ? 4 : 2,
						contentBase64: options.logsExceedRequestedBound === true ? 'b2theQ==' : 'b2s=',
						encoding: 'base64',
					},
					sequence: 0,
				},
				{
					channel: 'stderr',
					chunk: { byteLength: 3, contentBase64: 'ZXJy', encoding: 'base64' },
					sequence: 1,
				},
			],
			kind: 'logs',
			nextCursor: 'cursor-8',
			process: request.process,
			truncated: true,
		}),
	);
	const processRegistry = {
		cancel,
		closeStream: (): never => {
			throw new Error('Stream operations are not part of bounded process capabilities.');
		},
		logs,
		read: (): never => {
			throw new Error('Stream operations are not part of bounded process capabilities.');
		},
		retire: async (): Promise<void> => undefined,
		resizeTerminal: (): void => undefined,
		start,
		startShell: start,
		status,
		terminalExitCode: (): undefined => undefined,
		wait,
		write: async (): Promise<never> => {
			throw new Error('Stream operations are not part of bounded process capabilities.');
		},
	} satisfies GatewayRuntimeSandboxProcessRegistry;
	const endActiveUse = vi.fn(async (): Promise<void> => undefined);
	const retireGroup = vi.fn(async (): Promise<void> => undefined);
	const strictSshClient = {
		close: (): void => undefined,
		connect: async (): Promise<void> => undefined,
		execute: async (): Promise<never> => {
			throw new Error('Foreground execution is not part of this fixture.');
		},
		guestListDirectory: async (): Promise<never> => {
			throw new Error('Filesystem operations are not part of this fixture.');
		},
		guestMkdir: async (): Promise<never> => {
			throw new Error('Filesystem operations are not part of this fixture.');
		},
		guestReadFile: async (): Promise<never> => {
			throw new Error('Filesystem operations are not part of this fixture.');
		},
		guestRemove: async (): Promise<never> => {
			throw new Error('Filesystem operations are not part of this fixture.');
		},
		guestRename: async (): Promise<never> => {
			throw new Error('Filesystem operations are not part of this fixture.');
		},
		guestStat: async (): Promise<never> => {
			throw new Error('Filesystem operations are not part of this fixture.');
		},
		guestWriteFile: async (): Promise<never> => {
			throw new Error('Filesystem operations are not part of this fixture.');
		},
		listDirectory: async (): Promise<never> => {
			throw new Error('Filesystem operations are not part of this fixture.');
		},
		mkdir: async (): Promise<never> => {
			throw new Error('Filesystem operations are not part of this fixture.');
		},
		observeTransportFailure: () => ({ unsubscribe: (): void => undefined }),
		readFile: async (): Promise<never> => {
			throw new Error('Filesystem operations are not part of this fixture.');
		},
		remove: async (): Promise<never> => {
			throw new Error('Filesystem operations are not part of this fixture.');
		},
		rename: async (): Promise<never> => {
			throw new Error('Filesystem operations are not part of this fixture.');
		},
		stat: async (): Promise<never> => {
			throw new Error('Filesystem operations are not part of this fixture.');
		},
		writeFile: async (): Promise<never> => {
			throw new Error('Filesystem operations are not part of this fixture.');
		},
	} satisfies StrictToolVmSshClient;
	const port = createGatewayRuntimeToolVmRunnerBackendPort({
		acquisitionPort: {
			acquire: async (request) => {
				bindingRequests.push(request);
				const stablePrincipal = deriveGatewayControlStablePrincipal({
					principal: request.trustedContext.principal,
				});
				if (stablePrincipal !== operationContext.stablePrincipal) {
					return {
						kind: 'not-bound',
						owningGeneration: operationContext.environmentGeneration,
						reason: 'not-authorized',
					} as const;
				}
				return {
					endActiveUse,
					environmentGeneration: operationContext.environmentGeneration,
					kind: 'bound',
					operationAuthority,
					operationContext,
					processRegistry,
					retireGroup,
					strictSshClient,
				} as const;
			},
		},
		artifactWriter: {
			write: async (request) => {
				artifactWrites.push(request);
				return artifactReferenceFor(request);
			},
		},
		capabilityCatalog: processCatalog(),
	});
	return {
		artifactWrites,
		bindingRequests,
		cancel,
		endActiveUse,
		logs,
		operationAuthority,
		port,
		retireGroup,
		start,
		status,
		wait,
	};
}

function callOptions(
	operationId: string,
	context: GatewayRuntimeTrustedInvocationContext = trustedContext,
): ToolPortalBackendCallOptions<'tool_vm_runner'> {
	return {
		dispatchAuthority: {
			backendKind: 'tool_vm_runner',
			fingerprint: `sha256:${'d'.repeat(64)}`,
			kind: 'without-approval',
			operationId,
		},
		surfaceClass: 'protected_uds',
		trustedContext: context,
	};
}

async function callProcess(options: {
	readonly arguments: JsonObject;
	readonly context?: GatewayRuntimeTrustedInvocationContext;
	readonly fixture: ProcessFixture;
	readonly id: string;
	readonly name: string;
	readonly operationId: string;
}): Promise<PortalCallResult> {
	return PortalCallResultSchema.parse(
		await options.fixture.port.call(
			{
				calls: [
					{
						arguments: options.arguments,
						id: options.id,
						name: options.name,
						namespace: 'sandbox',
					},
				],
			},
			callOptions(options.operationId, options.context),
		),
	);
}

async function startRetainedProcess(fixture: ProcessFixture): Promise<void> {
	const result = await callProcess({
		arguments: {},
		fixture,
		id: 'prepare-process',
		name: 'process_start',
		operationId: '40000000-0000-4000-8000-000000000199',
	});
	if (result.items[0]?.status !== 'ok') throw new Error('Process fixture failed to start.');
}

describe('Gateway runtime bounded process backend port', () => {
	it('starts only the configured process and returns its canonical handle rather than the call operation ID', async () => {
		const fixture = createProcessFixture();
		const operationId = '40000000-0000-4000-8000-000000000101';

		const result = await callProcess({
			arguments: {},
			fixture,
			id: 'start-process',
			name: 'process_start',
			operationId,
		});

		expect(result.items[0]).toMatchObject({
			status: 'ok',
			value: { handleToken: process.handleId, kind: 'started' },
		});
		expect(result.items[0]).not.toMatchObject({ value: { handleToken: operationId } });
		expect(fixture.start).toHaveBeenCalledWith({
			argv: ['/usr/bin/watch-build', '--fixed'],
			cwd: 'repo',
			maxRuntimeMs: 30_000,
			retainOutputBytes: 4_096,
		});
		await vi.waitFor(() => expect(fixture.endActiveUse).toHaveBeenCalledOnce());
		expect(fixture.retireGroup).not.toHaveBeenCalled();
		expect(fixture.bindingRequests).toHaveLength(1);
	});

	it.each(['argv', 'cwd', 'executable', 'maxRuntimeMs', 'retainOutputBytes', 'runtime'] as const)(
		'rejects caller-authored process %s before binding',
		async (selector) => {
			const fixture = createProcessFixture();
			const result = await callProcess({
				arguments: { [selector]: selector.endsWith('Ms') ? 1 : 'attacker-selected' },
				fixture,
				id: `start-with-${selector}`,
				name: 'process_start',
				operationId: '40000000-0000-4000-8000-000000000102',
			});

			expect(result.items[0]).toMatchObject({ outcome: { kind: 'not-dispatched' } });
			expect(fixture.bindingRequests).toHaveLength(0);
			expect(fixture.start).not.toHaveBeenCalled();
		},
	);

	it('projects status, wait, and cancel truth without exposing canonical operation identity', async () => {
		const fixture = createProcessFixture();
		await startRetainedProcess(fixture);
		const statusResult = await callProcess({
			arguments: { handleToken: process.handleId },
			fixture,
			id: 'status-process',
			name: 'process_status',
			operationId: '40000000-0000-4000-8000-000000000103',
		});
		const waitResult = await callProcess({
			arguments: { handleToken: process.handleId },
			fixture,
			id: 'wait-process',
			name: 'process_wait',
			operationId: '40000000-0000-4000-8000-000000000104',
		});
		const cancelResult = await callProcess({
			arguments: { handleToken: process.handleId },
			fixture,
			id: 'cancel-process',
			name: 'process_cancel',
			operationId: '40000000-0000-4000-8000-000000000105',
		});

		expect(statusResult.items[0]).toMatchObject({ status: 'ok', value: { kind: 'running' } });
		expect(waitResult.items[0]).toMatchObject({
			status: 'ok',
			value: { kind: 'terminal', outcome: { kind: 'completed' } },
		});
		expect(cancelResult.items[0]).toMatchObject({
			status: 'ok',
			value: { kind: 'cancel-request-accepted' },
		});
		expect(JSON.stringify({ cancelResult, statusResult, waitResult })).not.toContain(
			operation.operationId,
		);
		expect(fixture.wait).toHaveBeenCalledWith({ process, timeoutMs: 500 });
		expect(fixture.bindingRequests).toHaveLength(1);
	});

	it('writes channel-specific log artifacts and preserves cursor, truncation, and requested bounds', async () => {
		const fixture = createProcessFixture();
		await startRetainedProcess(fixture);
		const result = await callProcess({
			arguments: { cursor: 'cursor-7', handleToken: process.handleId, maxBytes: 64 },
			fixture,
			id: 'logs-process',
			name: 'process_logs',
			operationId: '40000000-0000-4000-8000-000000000106',
		});

		expect(result.items[0]).toMatchObject({
			artifacts: [
				{ byteLength: 2, id: '40000000-0000-4000-8000-000000000106-stdout' },
				{ byteLength: 3, id: '40000000-0000-4000-8000-000000000106-stderr' },
			],
			status: 'ok',
			value: {
				byteLength: 5,
				chunkCount: 2,
				kind: 'logs',
				nextCursor: 'cursor-8',
				truncated: true,
			},
		});
		expect(fixture.logs).toHaveBeenCalledWith({
			channels: ['stdout', 'stderr'],
			cursor: 'cursor-7',
			maxBytes: 64,
			process,
		});
		expect(fixture.artifactWrites.map((write) => write.role)).toEqual(['stdout', 'stderr']);
	});

	it('rejects oversized log requests and oversized canonical results at their respective boundaries', async () => {
		const requestFixture = createProcessFixture();
		const requestResult = await callProcess({
			arguments: {
				handleToken: process.handleId,
				maxBytes: MAXIMUM_TOOL_VM_RUNNER_PROCESS_LOG_BYTES + 1,
			},
			fixture: requestFixture,
			id: 'oversized-request',
			name: 'process_logs',
			operationId: '40000000-0000-4000-8000-000000000107',
		});
		const resultFixture = createProcessFixture({ logsExceedRequestedBound: true });
		await startRetainedProcess(resultFixture);
		const result = await callProcess({
			arguments: { handleToken: process.handleId, maxBytes: 5 },
			fixture: resultFixture,
			id: 'oversized-result',
			name: 'process_logs',
			operationId: '40000000-0000-4000-8000-000000000108',
		});

		expect(requestResult.items[0]).toMatchObject({ outcome: { kind: 'not-dispatched' } });
		expect(requestFixture.bindingRequests).toHaveLength(0);
		expect(result.items[0]).toMatchObject({
			outcome: { completion: 'failed', kind: 'completed' },
			status: 'error',
		});
		expect(resultFixture.artifactWrites).toHaveLength(0);
	});

	it('allows the same stable principal across calls and denies replacement or a foreign principal', async () => {
		const fixture = createProcessFixture();
		await startRetainedProcess(fixture);
		const samePrincipalResult = await callProcess({
			arguments: { handleToken: process.handleId },
			context: {
				...trustedContext,
				correlation: { runId: 'run-b', sessionId: 'session-b', toolCallId: 'tool-call-b' },
				requester: { authenticatedSubjectId: 'subject-b' },
			},
			fixture,
			id: 'same-principal-status',
			name: 'process_status',
			operationId: '40000000-0000-4000-8000-000000000109',
		});
		const foreignResult = await callProcess({
			arguments: { handleToken: process.handleId },
			context: {
				...trustedContext,
				principal: { ...trustedContext.principal, toolPortalProfileId: 'foreign-profile' },
			},
			fixture,
			id: 'foreign-status',
			name: 'process_status',
			operationId: '40000000-0000-4000-8000-000000000110',
		});
		fixture.operationAuthority.beginReplacement({
			replacementLeafGeneration: 'leaf-generation-8',
		});
		const replacementResult = await callProcess({
			arguments: { handleToken: process.handleId },
			fixture,
			id: 'replacement-status',
			name: 'process_status',
			operationId: '40000000-0000-4000-8000-000000000111',
		});

		expect(samePrincipalResult.items[0]).toMatchObject({ status: 'ok' });
		expect(foreignResult.items[0]).toMatchObject({ outcome: { kind: 'not-dispatched' } });
		expect(replacementResult.items[0]).toMatchObject({ outcome: { kind: 'not-dispatched' } });
		expect(fixture.status).toHaveBeenCalledTimes(1);
		expect(fixture.bindingRequests).toHaveLength(1);
	});

	it('evicts the oldest retained terminal process group at the existing bound of 32', async () => {
		const fixture = createProcessFixture();

		await Promise.all(
			Array.from(
				{ length: 33 },
				async (_unusedValue, processIndex) =>
					await callProcess({
						arguments: {},
						fixture,
						id: `start-process-${String(processIndex)}`,
						name: 'process_start',
						operationId: `40000000-0000-4000-8000-${String(processIndex).padStart(12, '0')}`,
					}),
			),
		);

		await vi.waitFor(() => expect(fixture.endActiveUse).toHaveBeenCalledTimes(33));
		expect(fixture.retireGroup).toHaveBeenCalledOnce();
		expect(fixture.bindingRequests).toHaveLength(33);
	});

	it('retires retained background groups when the backend shuts down', async () => {
		const fixture = createProcessFixture();
		await startRetainedProcess(fixture);
		await vi.waitFor(() => expect(fixture.endActiveUse).toHaveBeenCalledOnce());

		await Promise.all([fixture.port.retire(), fixture.port.retire()]);

		expect(fixture.retireGroup).toHaveBeenCalledOnce();
	});

	it.each([
		['pre-dispatch process limit', 'not-dispatched'],
		['post-open transport ambiguity', 'ambiguous'],
	] as const)('preserves %s start disposition', async (_label, disposition) => {
		const fixture = createProcessFixture({
			startError: new StrictToolVmSshProcessStartError({
				cause: new Error('classified runtime failure'),
				disposition,
				message: 'classified runtime failure',
			}),
		});
		const result = await callProcess({
			arguments: {},
			fixture,
			id: `start-${disposition}`,
			name: 'process_start',
			operationId: '40000000-0000-4000-8000-000000000112',
		});

		expect(result.items[0]).toMatchObject({ outcome: { kind: disposition }, status: 'error' });
	});
});
