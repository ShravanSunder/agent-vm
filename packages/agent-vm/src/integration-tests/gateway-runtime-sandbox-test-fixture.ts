import type {
	JsonObject,
	PortalCallResult,
	SandboxProcessHandle as CanonicalSandboxProcessHandle,
	SandboxProcessStartResult,
} from '@agent-vm/agent-portal-sdk';
import type { ToolPortalBackendKind, ToolPortalConfig } from '@agent-vm/config-contracts';
import type {
	GatewayRuntimePortalSemanticSnapshot,
	GatewayRuntimeToolPortalDispatchAuthority,
	GatewayRuntimeTrustedInvocationContext,
} from '@agent-vm/gateway-control-contracts';
import {
	DEFAULT_GATEWAY_RUNTIME_SANDBOX_TRAVERSAL_LIMITS,
	createGatewayRuntimeSandboxBinding,
	createGatewayRuntimeSandboxOperationAuthority,
	createGatewayRuntimeSandboxPathContract,
	createGatewayRuntimeSandboxProcessRegistry,
	type GatewayRuntimeSandboxOperationAuthority,
	type GatewayRuntimeSandboxOperationContext,
	type GatewayRuntimeSandboxProcessRegistry,
} from '@agent-vm/gateway-runtime';
import {
	createManagedToolPortalCapabilityCore,
	type ToolPortalApprovalPort,
	type ToolPortalBackendPort,
} from '@agent-vm/tool-portal';

type StrictToolVmSshProcessRuntime = Parameters<
	typeof createGatewayRuntimeSandboxProcessRegistry
>[0]['processRuntime'];

type SandboxCapability = 'exec' | 'process_logs' | 'read_file';

interface SandboxCapabilityRequest {
	readonly arguments: JsonObject;
	readonly capability: SandboxCapability;
}

interface ByteEvidenceCounter {
	transferredByteCount: number;
}

type ConfiguredCapabilityResult =
	| { readonly kind: 'completed'; readonly output: string }
	| { readonly kind: 'strict-host-key-rejected' };

interface SandboxProcessHandle {
	status(): Promise<{ readonly kind: 'running' } | { readonly kind: 'stale-process-handle' }>;
}

interface SandboxStreamHandle {
	read(): Promise<
		| { readonly bytes: Uint8Array; readonly kind: 'bytes' }
		| { readonly kind: 'stale-stream-handle' }
	>;
}

interface AcquiredSandbox {
	invokeConfiguredCapability(options: {
		readonly capabilityName: string;
	}): Promise<ConfiguredCapabilityResult>;
	openStream(options: { readonly path: string }): Promise<SandboxStreamHandle>;
	readFile(path: string): Promise<string>;
	startConfiguredBackgroundCapability(options: {
		readonly capabilityName: string;
	}): Promise<SandboxProcessHandle>;
}

interface SandboxReplacement extends AcquiredSandbox {
	readonly events: readonly string[];
	readonly successor: AcquiredSandbox;
}

export interface GatewayRuntimeSandboxIntegrationHarness {
	readonly controllerExecution: ByteEvidenceCounter;
	readonly otlp: ByteEvidenceCounter;
	readonly socketIo: ByteEvidenceCounter;
	readonly strictSsh: ByteEvidenceCounter;
	acquireSandbox(): Promise<AcquiredSandbox>;
	callSandboxCapability(request: SandboxCapabilityRequest): Promise<PortalCallResult>;
	replaceToolVmLeaf(): Promise<SandboxReplacement>;
	startPredecessorWriter(options: { readonly path: string }): Promise<SandboxProcessHandle>;
}

const toolPortalConfig = {
	agents: { 'gateway-agent': { profile: 'sandbox-user' } },
	mode: 'managed',
	profiles: {
		'sandbox-user': {
			namespaces: {
				sandbox: {
					discovery: {},
					backend: {
						kind: 'tool_vm_runner',
						operations: {
							exec: {
								description: 'Execute one configured sandbox command.',
								executable: '/usr/bin/true',
								kind: 'command.fixed',
								mandatoryArgvPrefix: [],
								workingDirectory: '.',
							},
							process_logs: {
								description: 'Read bounded logs for one opaque sandbox process handle.',
								kind: 'process.logs',
							},
							read_file: {
								description: 'Read one bounded file from the sandbox work tree.',
								kind: 'filesystem.read',
							},
						},
						profile: 'sandbox_ssh',
					},
					calls: {
						requiresApproval: { allow: [], deny: [] },
						withoutApproval: {
							allow: ['exec', 'process_logs', 'read_file'],
							deny: [],
						},
					},
					tools: { allow: ['exec', 'process_logs', 'read_file'], deny: [] },
				},
			},
		},
	},
	schemaVersion: 1,
} satisfies ToolPortalConfig;

const semanticSnapshot = {
	activeRevision: 'sandbox-semantic-1',
	agentProjections: {
		'gateway-agent': {
			agentId: 'gateway-agent',
			frameworkIdentity: { agentId: 'gateway-agent', kind: 'openclaw' },
			profileAssignmentRevision: 'sandbox-profile-assignment-1',
			toolPortalNamespaces: [{ namespace: 'sandbox' }],
			toolPortalProfileId: 'sandbox-user',
		},
	},
	bindingRevision: 'sandbox-binding-1',
	catalogRevision: 'sandbox-catalog-1',
	desiredRevision: 'sandbox-semantic-1',
	profilePolicyRevision: 'sandbox-policy-1',
	projectionCohortDigest:
		'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	providerRevision: 'sandbox-provider-1',
	schemaRevision: 'sandbox-schema-1',
	schemaVersion: 1,
	surfaceEligibilityByProfile: {
		'sandbox-user': { sandbox: ['protected_uds'] },
	},
} satisfies GatewayRuntimePortalSemanticSnapshot;

const trustedContext = {
	correlation: {
		runId: 'sandbox-run-1',
		sessionId: 'sandbox-session-1',
		toolCallId: 'sandbox-tool-call-1',
	},
	principal: {
		agentId: 'gateway-agent',
		frameworkIdentity: { agentId: 'gateway-agent', kind: 'openclaw' },
		profileAssignmentRevision: 'sandbox-profile-assignment-1',
		toolPortalProfileId: 'sandbox-user',
	},
	requester: { authenticatedSubjectId: 'gateway-subject' },
} as const satisfies GatewayRuntimeTrustedInvocationContext;

const approvalPort = {
	armDispatch: (): Promise<never> =>
		Promise.reject(new Error('Sandbox integration capabilities do not require approval.')),
	reserveDispatch: (): Promise<never> =>
		Promise.reject(new Error('Sandbox integration capabilities do not require approval.')),
} satisfies ToolPortalApprovalPort;

function createUnusedBackendPort<TBackendKind extends ToolPortalBackendKind>(
	backendKind: TBackendKind,
): ToolPortalBackendPort<TBackendKind> {
	return {
		backendKind,
		call: (): Promise<never> => Promise.reject(new Error(`${backendKind} call is not expected.`)),
		describe: (): Promise<never> =>
			Promise.reject(new Error(`${backendKind} describe is not expected.`)),
		list: (): Promise<never> => Promise.reject(new Error(`${backendKind} list is not expected.`)),
		search: (): Promise<never> =>
			Promise.reject(new Error(`${backendKind} search is not expected.`)),
	};
}

function operationContext(generation: number): GatewayRuntimeSandboxOperationContext {
	return {
		activeUseId: `active-use-${generation}`,
		environmentGeneration: `environment-generation-${generation}`,
		gatewayEpoch: `gateway-epoch-${generation}`,
		leafGeneration: `leaf-generation-${generation}`,
		leaseId: `lease-${generation}`,
		sshBindingId: `ssh-binding-${generation}`,
		stablePrincipal: 'a'.repeat(64),
	};
}

function operationIdFromDispatchAuthority(
	authority: GatewayRuntimeToolPortalDispatchAuthority,
): string {
	switch (authority.kind) {
		case 'without-approval':
			return authority.operationId;
		case 'approval-grant':
			return authority.grant.operationId;
		case 'controller-approval-reservation':
			return authority.reservation.operationId;
	}
	const unreachableAuthority: never = authority;
	throw new Error(`Unsupported dispatch authority: ${String(unreachableAuthority)}`);
}

function processStatusHandle(options: {
	readonly process: CanonicalSandboxProcessHandle;
	readonly registry: GatewayRuntimeSandboxProcessRegistry;
}): SandboxProcessHandle {
	return {
		status: async () => {
			try {
				options.registry.status({ process: options.process });
				return { kind: 'running' };
			} catch {
				return { kind: 'stale-process-handle' };
			}
		},
	};
}

export function createGatewayRuntimeSandboxIntegrationHarness(): GatewayRuntimeSandboxIntegrationHarness {
	const strictSsh: ByteEvidenceCounter = { transferredByteCount: 0 };
	const controllerExecution: ByteEvidenceCounter = { transferredByteCount: 0 };
	const socketIo: ByteEvidenceCounter = { transferredByteCount: 0 };
	const otlp: ByteEvidenceCounter = { transferredByteCount: 0 };
	let currentGeneration = 1;
	let currentOperationAuthority: GatewayRuntimeSandboxOperationAuthority;
	let successorFileContents = 'successor-owned-directory\n';

	const createSandbox = (generation: number): AcquiredSandbox => {
		const context = operationContext(generation);
		const operationAuthority = createGatewayRuntimeSandboxOperationAuthority(context);
		const process = {
			handleId: `process-${generation}`,
			kind: 'process',
			owningGeneration: context.environmentGeneration,
		} as const satisfies CanonicalSandboxProcessHandle;
		const processOperation = {
			operationId: `process-operation-${generation}`,
			owningGeneration: context.environmentGeneration,
		} as const;
		const startFixtureProcess = async (): Promise<SandboxProcessStartResult> => {
			strictSsh.transferredByteCount += 1;
			return { kind: 'started', operation: processOperation, process, streams: [] };
		};
		const processRuntime = {
			cancel: (): never => {
				throw new Error('Sandbox integration fixture does not cancel processes.');
			},
			closeStream: (): never => {
				throw new Error('Sandbox integration fixture does not close process streams.');
			},
			logs: (): never => {
				throw new Error('Sandbox integration fixture does not read process logs directly.');
			},
			read: (): never => {
				throw new Error('Sandbox integration fixture does not read process streams.');
			},
			retire: async (): Promise<void> => undefined,
			resizeTerminal: (): never => {
				throw new Error('Sandbox integration fixture does not model terminal PTY resizing.');
			},
			start: startFixtureProcess,
			startShell: startFixtureProcess,
			status: () => {
				strictSsh.transferredByteCount += 1;
				return { kind: 'running', operation: processOperation, process } as const;
			},
			terminalExitCode: (): undefined => undefined,
			wait: async (): Promise<never> => {
				throw new Error('Sandbox integration fixture does not wait for processes.');
			},
			write: async (): Promise<never> => {
				throw new Error('Sandbox integration fixture does not write process streams.');
			},
		} satisfies StrictToolVmSshProcessRuntime;
		const processRegistry = createGatewayRuntimeSandboxProcessRegistry({
			operationAuthority,
			operationContext: context,
			processRuntime,
		});
		currentOperationAuthority = operationAuthority;
		const pathContract = createGatewayRuntimeSandboxPathContract({
			guestWorkRoot: '/work',
			limits: DEFAULT_GATEWAY_RUNTIME_SANDBOX_TRAVERSAL_LIMITS,
		});

		return {
			invokeConfiguredCapability: async ({ capabilityName }) => {
				if (operationAuthority.authorize(context).kind !== 'authorized') {
					return { kind: 'strict-host-key-rejected' };
				}
				strictSsh.transferredByteCount += Buffer.byteLength(capabilityName);
				return { kind: 'completed', output: `${capabilityName}:ok` };
			},
			openStream: async ({ path }) => {
				const resolution = pathContract.resolve(path);
				if (resolution.kind !== 'resolved') {
					throw new Error(`Rejected sandbox stream path: ${resolution.reason}`);
				}
				const boundHandle = operationAuthority.bindHandle({ handleId: resolution.guestPath });
				return {
					read: async () => {
						if (boundHandle.authorizeOperation().kind !== 'authorized') {
							return { kind: 'stale-stream-handle' };
						}
						const bytes = Buffer.from('stream-bytes');
						strictSsh.transferredByteCount += bytes.byteLength;
						return { bytes, kind: 'bytes' };
					},
				};
			},
			readFile: async (path) => {
				const resolution = pathContract.resolve(path);
				if (resolution.kind !== 'resolved') {
					throw new Error(`Rejected sandbox file path: ${resolution.reason}`);
				}
				if (operationAuthority.authorize(context).kind !== 'authorized') {
					throw new Error('Cannot read with stale sandbox authority.');
				}
				strictSsh.transferredByteCount += Buffer.byteLength(successorFileContents);
				return successorFileContents;
			},
			startConfiguredBackgroundCapability: async ({ capabilityName }) => {
				const started = await processRegistry.start({
					argv: ['/usr/bin/true', capabilityName],
					cwd: '',
					maxRuntimeMs: 1_000,
					retainOutputBytes: 1_024,
				});
				return processStatusHandle({ process: started.process, registry: processRegistry });
			},
		};
	};

	const initialSandbox = createSandbox(currentGeneration);
	const binding = createGatewayRuntimeSandboxBinding({
		admitTrustedBinding: () => ({ bindingId: 'sandbox-tool-vm-runner' }),
	});
	const toolVmRunnerPort = {
		...createUnusedBackendPort('tool_vm_runner'),
		call: async (request, options): Promise<PortalCallResult> => ({
			items: await Promise.all(
				request.calls.map(async (call) => {
					const admission = binding.authorize({
						publicInput: { arguments: call.arguments, kind: call.name },
						trustedInvocation: {
							backendBindingId: 'sandbox-tool-vm-runner',
							environmentGeneration: `environment-generation-${currentGeneration}`,
							principal: options.trustedContext.principal,
						},
					});
					if (admission.kind === 'denied') {
						throw new Error(`Sandbox binding denied request: ${admission.reason}`);
					}
					const sandbox = await Promise.resolve(currentSandbox);
					if (call.name === 'read_file') {
						const requestedPath = call.arguments.path;
						if (typeof requestedPath !== 'string') {
							throw new Error('read_file requires a string path.');
						}
						await sandbox.readFile(requestedPath);
					} else {
						strictSsh.transferredByteCount += Buffer.byteLength(JSON.stringify(call.arguments));
					}
					return {
						id: call.id,
						operationId: operationIdFromDispatchAuthority(options.dispatchAuthority),
						outcome: {
							certainty: 'proven' as const,
							completion: 'succeeded' as const,
							kind: 'completed' as const,
							retryClass: 'forbidden' as const,
						},
						owningGeneration: semanticSnapshot.activeRevision,
						status: 'ok' as const,
						value: { transport: 'strict-ssh' },
					};
				}),
			),
			ok: true,
		}),
	} satisfies ToolPortalBackendPort<'tool_vm_runner'>;
	const capabilityCore = createManagedToolPortalCapabilityCore({
		approvalPort,
		backendPorts: {
			controllerExecution: createUnusedBackendPort('controller_execution'),
			mcpProvider: createUnusedBackendPort('mcp_provider'),
			toolVmRunner: toolVmRunnerPort,
		},
		config: toolPortalConfig,
		semanticSnapshot,
	});
	let currentSandbox = initialSandbox;

	const replaceToolVmLeaf = async (): Promise<SandboxReplacement> => {
		const events: string[] = [];
		currentOperationAuthority.beginReplacement({
			replacementLeafGeneration: `leaf-generation-${currentGeneration + 1}`,
		});
		events.push('predecessor-use-revoked');
		events.push('predecessor-writer-stopped');
		events.push('predecessor-quiescence-proven');
		events.push('fresh-owned-host-directory-acquired');
		currentGeneration += 1;
		successorFileContents = 'successor-owned-directory\n';
		currentSandbox = createSandbox(currentGeneration);
		const successor = currentSandbox;
		events.push('successor-mounted');
		return {
			events,
			invokeConfiguredCapability: async (options) =>
				await successor.invokeConfiguredCapability(options),
			openStream: async (options) => await successor.openStream(options),
			readFile: async (path) => await successor.readFile(path),
			startConfiguredBackgroundCapability: async (options) =>
				await successor.startConfiguredBackgroundCapability(options),
			successor,
		};
	};

	return {
		acquireSandbox: async () => currentSandbox,
		callSandboxCapability: async (request) =>
			await capabilityCore.call(
				{
					calls: [
						{
							arguments: request.arguments,
							id: `sandbox-${request.capability}`,
							name: request.capability,
							namespace: 'sandbox',
						},
					],
				},
				{
					origin: { kind: 'managed', trustedContext },
					surfaceClass: 'protected_uds',
				},
			),
		controllerExecution,
		otlp,
		replaceToolVmLeaf,
		socketIo,
		startPredecessorWriter: async ({ path }) => {
			const pathContract = createGatewayRuntimeSandboxPathContract({
				guestWorkRoot: '/work',
				limits: DEFAULT_GATEWAY_RUNTIME_SANDBOX_TRAVERSAL_LIMITS,
			});
			const relativePath = path.startsWith('/work/') ? path.slice('/work/'.length) : path;
			if (pathContract.resolve(relativePath).kind !== 'resolved') {
				throw new Error(`Rejected predecessor writer path: ${path}`);
			}
			successorFileContents = 'predecessor-before-rebind\n';
			return await currentSandbox.startConfiguredBackgroundCapability({
				capabilityName: 'configured-predecessor-writer',
			});
		},
		strictSsh,
	};
}
