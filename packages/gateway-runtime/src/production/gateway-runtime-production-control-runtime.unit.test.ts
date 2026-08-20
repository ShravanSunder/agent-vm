import {
	createGatewayRuntimeManagedToolPortalConfig,
	type ManagedToolPortalConfig,
} from '@agent-vm/config-contracts';
import type { ToolPortalApprovalPort } from '@agent-vm/tool-portal';
import { describe, expect, it, vi } from 'vitest';

import type { GatewayRuntimeArtifactStore } from '../artifacts/artifact-store.js';
import type {
	GatewayRuntimeToolVmRunnerArtifactWriter,
	GatewayRuntimeToolVmRunnerCapabilityCatalog,
} from '../backends/tool-vm-runner-backend-port.js';
import type { GatewayControlApplicationMessageHandler } from '../control-endpoint/gateway-control-endpoint-contracts.js';
import {
	GATEWAY_CONTROL_READY_PATH,
	GATEWAY_CONTROL_SOCKET_PATH,
	type GatewayControlEndpoint,
} from '../control-endpoint/gateway-control-endpoint.js';
import type {
	GatewayControlOperationActiveUseAcquisitionPort,
	GatewayControlOperationActiveUseRuntime,
} from '../control-endpoint/gateway-control-operation-active-use-runtime.js';
import type { GatewayControlPublishedBindingRuntime } from '../control-endpoint/gateway-control-published-binding-runtime.js';
import {
	createGatewayRuntimeSandboxOperationAuthority,
	type GatewayRuntimeSandboxOperationContext,
} from '../sandbox/sandbox-operation-authority.js';
import type { GatewayRuntimeSandboxProcessRegistry } from '../sandbox/sandbox-process-registry.js';
import type {
	StrictToolVmSshClient,
	StrictToolVmSshProcessChannelClient,
} from '../sandbox/strict-tool-vm-ssh-client.js';
import { createGatewayRuntimeUnavailableBackendPort } from '../testing/gateway-runtime-unavailable-ports.js';
import {
	createGatewayRuntimeProductionControlRuntime,
	type GatewayRuntimeProductionControlRuntimeDependencies,
} from './gateway-runtime-production-control-runtime.js';

async function rejectUnusedSshOperation(): Promise<never> {
	throw new Error('unused SSH operation');
}

function rejectUnusedProcessOperation(): never {
	throw new Error('unused process operation');
}

function controlEndpoint(port = 18_790): GatewayControlEndpoint {
	return {
		close: async (): Promise<void> => undefined,
		readiness: {
			host: '127.0.0.1',
			port,
			readyPath: GATEWAY_CONTROL_READY_PATH,
			socketPath: GATEWAY_CONTROL_SOCKET_PATH,
		},
		service: {
			close: async (): Promise<void> => undefined,
			emitApplicationMessage: async (): Promise<never> => {
				throw new Error('unused control emission');
			},
			getCredentialState: (): undefined => undefined,
			getCurrentAcceptedSession: (): undefined => undefined,
			handleReadyRequest: (): false => false,
			handleUpgrade: (): false => false,
			observeAcceptedSessions: () => ({ unsubscribe: (): void => undefined }),
			observeSessionState: () => ({ unsubscribe: (): void => undefined }),
			waitForAcceptedSession: async (): Promise<never> => {
				throw new Error('unused accepted-session wait');
			},
		},
	};
}

function strictSshClient(): StrictToolVmSshClient & StrictToolVmSshProcessChannelClient {
	return {
		close: (): void => undefined,
		connect: async (): Promise<void> => undefined,
		execute: rejectUnusedSshOperation,
		guestListDirectory: async () => [],
		guestMkdir: async (): Promise<void> => undefined,
		guestReadFile: async () => new Uint8Array(),
		guestRemove: async (): Promise<void> => undefined,
		guestRename: async (): Promise<void> => undefined,
		guestStat: async () => ({ byteLength: 0, kind: 'file' }),
		guestWriteFile: async (): Promise<void> => undefined,
		listDirectory: async () => [],
		mkdir: async (): Promise<void> => undefined,
		observeTransportFailure: () => ({ unsubscribe: (): void => undefined }),
		openProcessChannel: rejectUnusedSshOperation,
		openShellProcessChannel: rejectUnusedSshOperation,
		readFile: async () => new Uint8Array(),
		remove: async (): Promise<void> => undefined,
		rename: async (): Promise<void> => undefined,
		stat: async () => ({ byteLength: 0, kind: 'file' }),
		writeFile: async (): Promise<void> => undefined,
	};
}

function processRegistry(): GatewayRuntimeSandboxProcessRegistry {
	return {
		cancel: rejectUnusedProcessOperation,
		closeStream: rejectUnusedProcessOperation,
		logs: rejectUnusedProcessOperation,
		read: rejectUnusedProcessOperation,
		resizeTerminal: rejectUnusedProcessOperation,
		retire: async (): Promise<void> => undefined,
		start: async (): Promise<never> => rejectUnusedProcessOperation(),
		startShell: async (): Promise<never> => rejectUnusedProcessOperation(),
		status: rejectUnusedProcessOperation,
		terminalExitCode: rejectUnusedProcessOperation,
		wait: async (): Promise<never> => rejectUnusedProcessOperation(),
		write: async (): Promise<never> => rejectUnusedProcessOperation(),
	};
}

function toolPortalConfig(): ManagedToolPortalConfig {
	return {
		agents: {},
		mode: 'managed',
		profiles: {},
		schemaVersion: 1,
	};
}

function artifactStore(): GatewayRuntimeArtifactStore {
	return {
		beginWrite: async (): Promise<never> => {
			throw new Error('unused artifact write');
		},
		inspectCounters: () => ({
			activeReservations: 0,
			artifactCount: 0,
			committedBytes: 0,
			orphanedArtifactCount: 0,
			orphanedBytes: 0,
			reservedBytes: 0,
			retired: false,
		}),
		read: async (): Promise<never> => {
			throw new Error('unused artifact read');
		},
		retireEpoch: async (): Promise<void> => undefined,
	};
}

function runtimeProps(
	endpoint: GatewayControlEndpoint,
): Parameters<typeof createGatewayRuntimeProductionControlRuntime>[0] {
	return {
		artifactLifetimeMs: 45_000,
		controlAuthority: {
			callerContextAgentAuthorityKeys: { 'agent-a': 'agent-authority' },
			callerContextProofKey: 'caller-proof',
		},
		controlEndpoint: endpoint,
		owningGeneration: 'runtime-generation-a',
		toolPortalConfig: createGatewayRuntimeManagedToolPortalConfig(toolPortalConfig()),
		zoneId: 'zone-a',
	};
}

function observableDependencies(): {
	readonly acquisitionPort: GatewayControlOperationActiveUseAcquisitionPort;
	readonly activeUseRuntime: GatewayControlOperationActiveUseRuntime;
	readonly applicationMessageHandler: GatewayControlApplicationMessageHandler;
	readonly dependencies: GatewayRuntimeProductionControlRuntimeDependencies;
	readonly processRegistryFactory: ReturnType<typeof vi.fn>;
	readonly publishedBindingRuntime: GatewayControlPublishedBindingRuntime;
	readonly registrationClose: ReturnType<typeof vi.fn>;
	readonly retirementOrder: string[];
	readonly strictSshClientFactory: ReturnType<typeof vi.fn>;
} {
	const retirementOrder: string[] = [];
	const acquisitionPort: GatewayControlOperationActiveUseAcquisitionPort = {
		acquire: async ({ trustedContext }) => ({
			kind: 'not-bound',
			owningGeneration: trustedContext.principal.profileAssignmentRevision,
			reason: 'unavailable',
		}),
	};
	const registrationClose = vi.fn(async (): Promise<void> => undefined);
	const activeUseRuntime = {
		acquisitionPort,
		retire: vi.fn(async (): Promise<void> => {
			retirementOrder.push('operation-groups');
			await registrationClose();
		}),
	} satisfies GatewayControlOperationActiveUseRuntime;
	const publishedBindingRuntime = {
		applyPublication: vi.fn(async () => ({
			kind: 'ignored' as const,
			reason: 'runtime_closed' as const,
			state: { kind: 'unbound' as const, stablePrincipal: 'a'.repeat(64) },
		})),
		close: vi.fn(async (): Promise<void> => {
			retirementOrder.push('published-connections');
		}),
		lookupReadyConnection: vi.fn(({ trustedContext }) => ({
			kind: 'unavailable' as const,
			state: {
				kind: 'unbound' as const,
				stablePrincipal: trustedContext.principal.stablePrincipal,
			},
		})),
		readState: vi.fn(({ trustedContext }) => ({
			kind: 'unbound' as const,
			stablePrincipal: trustedContext.principal.stablePrincipal,
		})),
	} satisfies GatewayControlPublishedBindingRuntime;
	const applicationMessageHandler: GatewayControlApplicationMessageHandler = {
		handle: async (): Promise<never> => {
			throw new Error('unused application message');
		},
		messageIdentity: () => ({ kind: 'command', operation: 'ping' }),
	};
	const strictSshClientFactory = vi.fn(() => strictSshClient());
	const processRegistryFactory = vi.fn(() => processRegistry());
	const dependencies = {
		compileConfiguredCatalog: vi.fn(
			() => ({}) satisfies GatewayRuntimeToolVmRunnerCapabilityCatalog,
		),
		createApprovalPort: vi.fn(
			() => ({ armDispatch: vi.fn(), reserveDispatch: vi.fn() }) satisfies ToolPortalApprovalPort,
		),
		createApprovalDecisionOperations: vi.fn(() => ({
			decide: async (): Promise<never> => {
				throw new Error('unused approval decision');
			},
		})),
		createArtifactWriter: vi.fn(
			(): GatewayRuntimeToolVmRunnerArtifactWriter => ({
				write: async (): Promise<never> => {
					throw new Error('unused artifact writer');
				},
			}),
		),
		createBindingPublicationHandler: vi.fn(() => applicationMessageHandler),
		createCallerContextRegistrationClient: vi.fn(() => ({
			close: registrationClose,
			register: async (): Promise<never> => {
				throw new Error('unused registration');
			},
		})),
		createControlCommandClient: vi.fn(() => ({
			sendCommand: async (): Promise<never> => {
				throw new Error('unused command');
			},
		})),
		createControllerExecutionBackendPort: vi.fn(() =>
			createGatewayRuntimeUnavailableBackendPort({
				backendKind: 'controller_execution',
				owningGeneration: 'runtime-generation-a',
			}),
		),
		createOperationActiveUseRuntime: vi.fn(() => activeUseRuntime),
		createProcessRegistry: processRegistryFactory,
		createProcessRuntime: vi.fn(() => processRegistry()),
		createPublishedBindingRuntime: vi.fn(() => publishedBindingRuntime),
		createSandboxDispatcher: vi.fn(() => ({
			dispatch: async (): Promise<never> => {
				throw new Error('unused Sandbox dispatch');
			},
			retire: vi.fn(async (): Promise<void> => {
				retirementOrder.push('sandbox-consumers');
			}),
		})),
		createStrictSshClient: strictSshClientFactory,
		createToolVmRunnerBackendPort: vi.fn(() =>
			createGatewayRuntimeUnavailableBackendPort({
				backendKind: 'tool_vm_runner',
				owningGeneration: 'test-generation',
			}),
		),
	} satisfies GatewayRuntimeProductionControlRuntimeDependencies;
	return {
		acquisitionPort,
		activeUseRuntime,
		applicationMessageHandler,
		dependencies,
		processRegistryFactory,
		publishedBindingRuntime,
		registrationClose,
		retirementOrder,
		strictSshClientFactory,
	};
}

describe('Gateway Runtime production control runtime', () => {
	it('rejects an endpoint that is not listening before constructing control owners', async () => {
		const observed = observableDependencies();

		await expect(
			createGatewayRuntimeProductionControlRuntime(
				runtimeProps(controlEndpoint(0)),
				observed.dependencies,
			),
		).rejects.toThrow('already-listening');

		expect(observed.dependencies.createPublishedBindingRuntime).not.toHaveBeenCalled();
		expect(observed.dependencies.createOperationActiveUseRuntime).not.toHaveBeenCalled();
	});

	it('composes publication, active-use, and both production consumers over one acquisition port', async () => {
		const endpoint = controlEndpoint();
		const observed = observableDependencies();

		const runtime = await createGatewayRuntimeProductionControlRuntime(
			runtimeProps(endpoint),
			observed.dependencies,
		);

		expect(observed.dependencies.createPublishedBindingRuntime).toHaveBeenCalledWith({
			controlService: endpoint.service,
			createStrictSshClient: expect.any(Function),
		});
		expect(observed.dependencies.createOperationActiveUseRuntime).toHaveBeenCalledWith({
			callerContextRegistrationClient: expect.any(Object),
			controlCommandClient: expect.any(Object),
			controlService: endpoint.service,
			createCommandId: expect.any(Function),
			createProcessRegistry: expect.any(Function),
			createUseId: expect.any(Function),
			publishedBindingRuntime: observed.publishedBindingRuntime,
			scheduler: expect.objectContaining({ schedule: expect.any(Function) }),
		});
		expect(observed.dependencies.createBindingPublicationHandler).toHaveBeenCalledWith({
			applyPublication: observed.publishedBindingRuntime.applyPublication,
		});
		expect(observed.dependencies.createSandboxDispatcher).toHaveBeenCalledWith({
			acquisitionPort: observed.acquisitionPort,
		});
		expect(runtime.acquisitionPort).toBe(observed.acquisitionPort);
		expect(runtime.applicationMessageHandler).toBe(observed.applicationMessageHandler);
		expect(observed.dependencies.createControllerExecutionBackendPort).toHaveBeenCalledWith({
			callerContextRegistrationClient: expect.any(Object),
			controlCommandClient: expect.any(Object),
			createCommandId: expect.any(Function),
			owningGeneration: 'runtime-generation-a',
			toolPortalConfig: expect.any(Object),
		});
		expect(
			runtime.controllerExecutionBackendPortFactory({
				artifactStore: artifactStore(),
				registerArtifactAuthority: () => ({ kind: 'registered' }),
			}).backendKind,
		).toBe('controller_execution');

		runtime.toolVmRunnerBackendPortFactory({
			artifactStore: artifactStore(),
			registerArtifactAuthority: () => ({ kind: 'registered' }),
		});
		expect(observed.dependencies.createToolVmRunnerBackendPort).toHaveBeenCalledWith({
			acquisitionPort: observed.acquisitionPort,
			artifactWriter: expect.any(Object),
			capabilityCatalog: {},
		});
	});

	it('preserves the fixed SSH and process policies on the two new ownership runtimes', async () => {
		const observed = observableDependencies();
		await createGatewayRuntimeProductionControlRuntime(
			runtimeProps(controlEndpoint()),
			observed.dependencies,
		);
		const publishedProps = vi.mocked(observed.dependencies.createPublishedBindingRuntime).mock
			.calls[0]?.[0];
		const activeUseProps = vi.mocked(observed.dependencies.createOperationActiveUseRuntime).mock
			.calls[0]?.[0];
		if (publishedProps === undefined || activeUseProps === undefined) {
			throw new Error('Missing production control owners.');
		}

		const access = {
			host: 'tool-vm',
			identityPem: 'identity',
			knownHostsLine: 'tool-vm ssh-ed25519 AAAA',
			port: 22,
			user: 'root',
		};
		const client = publishedProps.createStrictSshClient(access);
		expect(observed.strictSshClientFactory).toHaveBeenCalledWith({
			access,
			deadlineMilliseconds: { connect: 10_000, operation: 30_000 },
			limits: {
				maxDirectoryEntries: 4_096,
				maxFileBytes: 16_777_216,
				maxPathDepth: 64,
				maxStderrBytes: 1_048_576,
				maxStdoutBytes: 1_048_576,
				maxSymlinkDepth: 8,
				maxWriteBytes: 65_536,
			},
			runtime: expect.objectContaining({
				clock: expect.objectContaining({ now: expect.any(Function) }),
				scheduler: expect.objectContaining({ schedule: expect.any(Function) }),
			}),
		});

		const operationContext = {
			activeUseId: '01989f0d-8f42-7aa1-9eb8-c4a654341234',
			environmentGeneration: 'environment-1',
			gatewayEpoch: 'gateway-epoch-1',
			leafGeneration: 'leaf-1',
			leaseId: 'lease-1',
			sshBindingId: 'ssh-1',
			stablePrincipal: 'a'.repeat(64),
		} satisfies GatewayRuntimeSandboxOperationContext;
		const operationAuthority = createGatewayRuntimeSandboxOperationAuthority(operationContext);
		activeUseProps.createProcessRegistry({
			operationAuthority,
			operationContext,
			strictSshClient: client,
		});
		expect(observed.dependencies.createProcessRuntime).toHaveBeenCalledWith({
			createHandleId: expect.any(Function),
			limits: expect.objectContaining({
				maximumProcessCount: 32,
				maximumRuntimeMilliseconds: 3_600_000,
				maximumWriteBytes: 65_536,
			}),
			owningGeneration: operationContext.environmentGeneration,
			scheduler: expect.objectContaining({ schedule: expect.any(Function) }),
			strictSshClient: client,
		});
	});

	it('retires consumers, operation groups, caller contexts, and published connections exactly once', async () => {
		const observed = observableDependencies();
		const runtime = await createGatewayRuntimeProductionControlRuntime(
			runtimeProps(controlEndpoint()),
			observed.dependencies,
		);

		await Promise.all([runtime.retire(), runtime.retire()]);

		expect(observed.retirementOrder).toEqual([
			'sandbox-consumers',
			'operation-groups',
			'published-connections',
		]);
		expect(observed.activeUseRuntime.retire).toHaveBeenCalledTimes(1);
		expect(observed.registrationClose).toHaveBeenCalledTimes(1);
		expect(observed.publishedBindingRuntime.close).toHaveBeenCalledTimes(1);
	});

	it('continues ordered authority retirement when a consumer retirement fails', async () => {
		const observed = observableDependencies();
		vi.mocked(observed.dependencies.createSandboxDispatcher).mockReturnValueOnce({
			dispatch: async (): Promise<never> => {
				throw new Error('unused Sandbox dispatch');
			},
			retire: vi.fn(async (): Promise<void> => {
				observed.retirementOrder.push('sandbox-consumers');
				throw new Error('sandbox retirement failed');
			}),
		});
		const runtime = await createGatewayRuntimeProductionControlRuntime(
			runtimeProps(controlEndpoint()),
			observed.dependencies,
		);

		await expect(runtime.retire()).rejects.toThrow(
			'Gateway Runtime production control retirement failed',
		);

		expect(observed.retirementOrder).toEqual([
			'sandbox-consumers',
			'operation-groups',
			'published-connections',
		]);
		expect(observed.registrationClose).toHaveBeenCalledTimes(1);
		expect(observed.publishedBindingRuntime.close).toHaveBeenCalledTimes(1);
	});

	it('closes partial published and caller-context ownership when active-use construction fails', async () => {
		const observed = observableDependencies();
		vi.mocked(observed.dependencies.createOperationActiveUseRuntime).mockImplementationOnce(() => {
			throw new Error('active-use construction failed');
		});

		await expect(
			createGatewayRuntimeProductionControlRuntime(
				runtimeProps(controlEndpoint()),
				observed.dependencies,
			),
		).rejects.toThrow('active-use construction failed');

		expect(observed.publishedBindingRuntime.close).toHaveBeenCalledTimes(1);
		expect(observed.registrationClose).toHaveBeenCalledTimes(1);
	});
});
