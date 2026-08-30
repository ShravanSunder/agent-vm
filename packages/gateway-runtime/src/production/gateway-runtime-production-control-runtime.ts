import { performance } from 'node:perf_hooks';

import {
	SANDBOX_MAXIMUM_BINARY_BYTES,
	SANDBOX_MAXIMUM_LIST_ITEMS,
	SANDBOX_MAXIMUM_OPERATION_MILLISECONDS,
} from '@agent-vm/agent-portal-sdk';
import type { GatewayRuntimeManagedToolPortalConfig } from '@agent-vm/config-contracts';
import type {
	ToolPortalApprovalPort,
	ToolPortalBackendPort,
	ToolPortalOAuthAvailabilityPort,
} from '@agent-vm/tool-portal';
import { v7 as uuidv7 } from 'uuid';

import {
	createGatewayControlControllerExecutionBackendPort,
	type CreateGatewayControlControllerExecutionBackendPortProps,
} from '../backends/controller-execution-gateway-control-adapter.js';
import {
	createGatewayRuntimeToolVmRunnerArtifactWriter,
	type CreateGatewayRuntimeToolVmRunnerArtifactWriterProps,
} from '../backends/tool-vm-runner-artifact-writer.js';
import {
	createGatewayRuntimeToolVmRunnerBackendPort,
	type CreateGatewayRuntimeToolVmRunnerBackendPortProps,
} from '../backends/tool-vm-runner-backend-port.js';
import { compileGatewayRuntimeToolVmRunnerConfiguredCatalog } from '../backends/tool-vm-runner-configured-catalog.js';
import { createGatewayControlBindingPublicationHandler } from '../control-endpoint/gateway-control-binding-publication-handler.js';
import {
	createGatewayControlCallerContextRegistrationClient,
	type CreateGatewayControlCallerContextRegistrationClientProps,
} from '../control-endpoint/gateway-control-caller-context-registration-client.js';
import {
	createGatewayRuntimeControlCommandClient,
	type CreateGatewayRuntimeControlCommandClientProps,
} from '../control-endpoint/gateway-control-command-client.js';
import {
	type GatewayControlApplicationMessageHandler,
	type GatewayControlEndpoint,
} from '../control-endpoint/gateway-control-endpoint.js';
import {
	createGatewayControlOperationActiveUseRuntime,
	type CreateGatewayControlOperationActiveUseRuntimeProps,
	type GatewayControlOperationActiveUseAcquisitionPort,
	type GatewayControlOperationActiveUseRuntime,
	type GatewayControlOperationActiveUseScheduler,
} from '../control-endpoint/gateway-control-operation-active-use-runtime.js';
import {
	createGatewayControlPublishedBindingRuntime,
	type CreateGatewayControlPublishedBindingRuntimeProps,
	type GatewayControlPublishedBindingRuntime,
} from '../control-endpoint/gateway-control-published-binding-runtime.js';
import {
	createGatewayRuntimeApprovalDecisionOperations,
	type GatewayRuntimeApprovalDecisionOperations,
} from '../gateway-runtime-approval-decision-operations.js';
import { createGatewayRuntimeApprovalPort } from '../gateway-runtime-approval-port.js';
import type { GatewayRuntimeManagedToolPortalBackendPortFactories } from '../managed-tool-portal-composition.js';
import { createGatewayControlOAuthAvailabilityPort } from '../oauth-availability-gateway-control-port.js';
import { createGatewayRuntimeSandboxProcessRegistry } from '../sandbox/sandbox-process-registry.js';
import {
	createStrictToolVmSshClient,
	createStrictToolVmSshTransport,
	type CreateStrictToolVmSshClientOptions,
	type StrictToolVmSshLimits,
} from '../sandbox/strict-tool-vm-ssh-client.js';
import {
	createStrictToolVmSshProcessRuntime,
	type StrictToolVmSshProcessRuntimeLimits,
} from '../sandbox/strict-tool-vm-ssh-process-runtime.js';
import type { GatewayRuntimeSandboxDispatchRequest } from './gateway-runtime-private-uds-dispatcher.js';
import {
	createGatewayRuntimeProductionSandboxDispatcher,
	type CreateGatewayRuntimeProductionSandboxDispatcherProps,
	type GatewayRuntimeProductionSandboxDispatcher,
} from './gateway-runtime-production-sandbox-dispatcher.js';

const PRODUCTION_STRICT_SSH_DEADLINES = Object.freeze({
	connect: 10_000,
	operation: 30_000,
});

const PRODUCTION_STRICT_SSH_LIMITS = Object.freeze({
	maxDirectoryEntries: 4_096,
	maxFileBytes: 16_777_216,
	maxPathDepth: 64,
	maxStderrBytes: 1_048_576,
	maxStdoutBytes: 1_048_576,
	maxSymlinkDepth: 8,
	maxWriteBytes: 65_536,
}) satisfies StrictToolVmSshLimits;

const PRODUCTION_STRICT_SSH_PROCESS_LIMITS = Object.freeze({
	maximumCursorRecordsPerProcess: 64,
	maximumLogChunksPerCall: SANDBOX_MAXIMUM_LIST_ITEMS,
	maximumOpenMilliseconds: PRODUCTION_STRICT_SSH_DEADLINES.operation,
	maximumProcessCount: 32,
	maximumReadBytes: SANDBOX_MAXIMUM_BINARY_BYTES,
	maximumReadChunksPerCall: 1,
	maximumRetainedOutputBytesPerProcess: SANDBOX_MAXIMUM_BINARY_BYTES,
	maximumRuntimeMilliseconds: SANDBOX_MAXIMUM_OPERATION_MILLISECONDS,
	maximumTerminalTombstones: 32,
	maximumWaitMilliseconds: SANDBOX_MAXIMUM_OPERATION_MILLISECONDS,
	maximumWriteBytes: PRODUCTION_STRICT_SSH_LIMITS.maxWriteBytes,
	maximumWriteRecordsPerProcess: 64,
	maximumWrittenBytesPerProcess: SANDBOX_MAXIMUM_BINARY_BYTES,
}) satisfies StrictToolVmSshProcessRuntimeLimits;

const productionScheduler: GatewayControlOperationActiveUseScheduler = Object.freeze({
	schedule: (callback: () => void, delayMilliseconds: number) => {
		const timer = setTimeout(callback, delayMilliseconds);
		timer.unref?.();
		return { cancel: (): void => clearTimeout(timer) };
	},
});

export interface GatewayRuntimeProductionControlAuthority {
	readonly callerContextAgentAuthorityKeys: Readonly<Record<string, string>>;
	readonly callerContextProofKey: string;
}

export interface CreateGatewayRuntimeProductionControlRuntimeProps {
	readonly artifactLifetimeMs: number;
	readonly controlAuthority: GatewayRuntimeProductionControlAuthority;
	readonly controlEndpoint: GatewayControlEndpoint;
	readonly owningGeneration: string;
	readonly toolPortalConfig: GatewayRuntimeManagedToolPortalConfig;
	readonly zoneId: string;
}

export interface GatewayRuntimeProductionControlRuntimeDependencies {
	readonly compileConfiguredCatalog: typeof compileGatewayRuntimeToolVmRunnerConfiguredCatalog;
	readonly createApprovalPort: typeof createGatewayRuntimeApprovalPort;
	readonly createApprovalDecisionOperations: typeof createGatewayRuntimeApprovalDecisionOperations;
	readonly createArtifactWriter: (
		props: CreateGatewayRuntimeToolVmRunnerArtifactWriterProps,
	) => ReturnType<typeof createGatewayRuntimeToolVmRunnerArtifactWriter>;
	readonly createCallerContextRegistrationClient: (
		props: CreateGatewayControlCallerContextRegistrationClientProps,
	) => ReturnType<typeof createGatewayControlCallerContextRegistrationClient>;
	readonly createControlCommandClient: (
		props: CreateGatewayRuntimeControlCommandClientProps,
	) => ReturnType<typeof createGatewayRuntimeControlCommandClient>;
	readonly createControllerExecutionBackendPort: (
		props: CreateGatewayControlControllerExecutionBackendPortProps,
	) => ToolPortalBackendPort<'controller_execution'>;
	readonly createBindingPublicationHandler: typeof createGatewayControlBindingPublicationHandler;
	readonly createOperationActiveUseRuntime: (
		props: CreateGatewayControlOperationActiveUseRuntimeProps,
	) => GatewayControlOperationActiveUseRuntime;
	readonly createOAuthAvailabilityPort: typeof createGatewayControlOAuthAvailabilityPort;
	readonly createProcessRuntime: typeof createStrictToolVmSshProcessRuntime;
	readonly createProcessRegistry: typeof createGatewayRuntimeSandboxProcessRegistry;
	readonly createPublishedBindingRuntime: (
		props: CreateGatewayControlPublishedBindingRuntimeProps,
	) => GatewayControlPublishedBindingRuntime;
	readonly createSandboxDispatcher: (
		props: CreateGatewayRuntimeProductionSandboxDispatcherProps,
	) => GatewayRuntimeProductionSandboxDispatcher;
	readonly createStrictSshClient: (
		options: CreateStrictToolVmSshClientOptions,
	) => ReturnType<typeof createStrictToolVmSshClient>;
	readonly createToolVmRunnerBackendPort: (
		props: CreateGatewayRuntimeToolVmRunnerBackendPortProps,
	) => ToolPortalBackendPort<'tool_vm_runner'>;
}

export interface GatewayRuntimeProductionControlRuntime {
	readonly acquisitionPort: GatewayControlOperationActiveUseAcquisitionPort;
	readonly approvalPort: ToolPortalApprovalPort;
	readonly approvalDecisionOperations: GatewayRuntimeApprovalDecisionOperations;
	readonly applicationMessageHandler: GatewayControlApplicationMessageHandler;
	readonly controllerExecutionBackendPortFactory: GatewayRuntimeManagedToolPortalBackendPortFactories['controllerExecution'];
	readonly oauthAvailabilityPort: ToolPortalOAuthAvailabilityPort;
	readonly retire: () => Promise<void>;
	readonly sandboxDispatch: (request: GatewayRuntimeSandboxDispatchRequest) => Promise<unknown>;
	readonly toolVmRunnerBackendPortFactory: GatewayRuntimeManagedToolPortalBackendPortFactories['toolVmRunner'];
}

const defaultDependencies = Object.freeze({
	compileConfiguredCatalog: compileGatewayRuntimeToolVmRunnerConfiguredCatalog,
	createApprovalPort: createGatewayRuntimeApprovalPort,
	createApprovalDecisionOperations: createGatewayRuntimeApprovalDecisionOperations,
	createArtifactWriter: createGatewayRuntimeToolVmRunnerArtifactWriter,
	createBindingPublicationHandler: createGatewayControlBindingPublicationHandler,
	createCallerContextRegistrationClient: createGatewayControlCallerContextRegistrationClient,
	createControlCommandClient: createGatewayRuntimeControlCommandClient,
	createControllerExecutionBackendPort: createGatewayControlControllerExecutionBackendPort,
	createOperationActiveUseRuntime: createGatewayControlOperationActiveUseRuntime,
	createOAuthAvailabilityPort: createGatewayControlOAuthAvailabilityPort,
	createProcessRuntime: createStrictToolVmSshProcessRuntime,
	createProcessRegistry: createGatewayRuntimeSandboxProcessRegistry,
	createPublishedBindingRuntime: createGatewayControlPublishedBindingRuntime,
	createSandboxDispatcher: createGatewayRuntimeProductionSandboxDispatcher,
	createStrictSshClient: createStrictToolVmSshClient,
	createToolVmRunnerBackendPort: createGatewayRuntimeToolVmRunnerBackendPort,
}) satisfies GatewayRuntimeProductionControlRuntimeDependencies;

function assertAlreadyListeningControlEndpoint(controlEndpoint: GatewayControlEndpoint): void {
	const readiness = controlEndpoint.readiness;
	if (
		readiness.host.trim() === '' ||
		!Number.isInteger(readiness.port) ||
		readiness.port <= 0 ||
		readiness.port > 65_535
	) {
		throw new Error(
			'Gateway Runtime production control composition requires an already-listening control endpoint.',
		);
	}
}

function assertPositiveSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive safe integer.`);
	}
}

export async function createGatewayRuntimeProductionControlRuntime(
	props: CreateGatewayRuntimeProductionControlRuntimeProps,
	dependencyOverrides: Partial<GatewayRuntimeProductionControlRuntimeDependencies> = {},
): Promise<GatewayRuntimeProductionControlRuntime> {
	assertAlreadyListeningControlEndpoint(props.controlEndpoint);
	assertPositiveSafeInteger(props.artifactLifetimeMs, 'Tool VM runner artifact lifetime');
	const dependencies = { ...defaultDependencies, ...dependencyOverrides };
	const controlService = props.controlEndpoint.service;
	const controlCommandClient = dependencies.createControlCommandClient({ controlService });
	const approvalPort = dependencies.createApprovalPort({
		controlCommandPort: controlCommandClient,
		zoneId: props.zoneId,
	});
	const callerContextRegistrationClient = dependencies.createCallerContextRegistrationClient({
		agentAuthorityKeys: props.controlAuthority.callerContextAgentAuthorityKeys,
		callerContextProofKey: props.controlAuthority.callerContextProofKey,
		controlCommandClient,
		controlService,
	});
	const approvalDecisionOperations = dependencies.createApprovalDecisionOperations({
		callerContextRegistrationClient,
		controlCommandClient,
	});
	const oauthAvailabilityPort = dependencies.createOAuthAvailabilityPort({
		callerContextRegistrationClient,
		controlCommandClient,
	});
	let controllerExecutionBackendPort: ToolPortalBackendPort<'controller_execution'>;
	try {
		controllerExecutionBackendPort = dependencies.createControllerExecutionBackendPort({
			callerContextRegistrationClient,
			controlCommandClient,
			createCommandId: uuidv7,
			owningGeneration: props.owningGeneration,
			toolPortalConfig: props.toolPortalConfig,
		});
	} catch (error: unknown) {
		await callerContextRegistrationClient.close().catch(() => undefined);
		throw error;
	}
	const createStrictSshClient = (
		access: Parameters<
			CreateGatewayControlPublishedBindingRuntimeProps['createStrictSshClient']
		>[0],
	): ReturnType<CreateGatewayControlPublishedBindingRuntimeProps['createStrictSshClient']> =>
		dependencies.createStrictSshClient({
			access,
			deadlineMilliseconds: PRODUCTION_STRICT_SSH_DEADLINES,
			limits: PRODUCTION_STRICT_SSH_LIMITS,
			runtime: {
				clock: { now: (): number => performance.now() },
				createSshClient: createStrictToolVmSshTransport,
				scheduler: productionScheduler,
			},
		});
	const createProcessRegistry: CreateGatewayControlOperationActiveUseRuntimeProps['createProcessRegistry'] =
		({ operationAuthority, operationContext, strictSshClient }) =>
			dependencies.createProcessRegistry({
				operationAuthority,
				operationContext,
				processRuntime: dependencies.createProcessRuntime({
					createHandleId: (kind) => `${kind}:${uuidv7()}`,
					limits: PRODUCTION_STRICT_SSH_PROCESS_LIMITS,
					owningGeneration: operationContext.environmentGeneration,
					scheduler: productionScheduler,
					strictSshClient,
				}),
			});
	let publishedBindingRuntime: GatewayControlPublishedBindingRuntime;
	try {
		publishedBindingRuntime = dependencies.createPublishedBindingRuntime({
			controlService,
			createStrictSshClient,
		});
	} catch (error: unknown) {
		await callerContextRegistrationClient.close().catch(() => undefined);
		throw error;
	}
	let operationActiveUseRuntime: GatewayControlOperationActiveUseRuntime;
	try {
		operationActiveUseRuntime = dependencies.createOperationActiveUseRuntime({
			callerContextRegistrationClient,
			controlCommandClient,
			controlService,
			createCommandId: uuidv7,
			createProcessRegistry,
			createUseId: uuidv7,
			publishedBindingRuntime,
			scheduler: productionScheduler,
		});
	} catch (error: unknown) {
		await publishedBindingRuntime.close().catch(() => undefined);
		await callerContextRegistrationClient.close().catch(() => undefined);
		throw error;
	}
	const acquisitionPort = operationActiveUseRuntime.acquisitionPort;
	let applicationMessageHandler: GatewayControlApplicationMessageHandler;
	let sandboxDispatcher: GatewayRuntimeProductionSandboxDispatcher;
	try {
		applicationMessageHandler = dependencies.createBindingPublicationHandler({
			applyPublication: publishedBindingRuntime.applyPublication,
		});
		sandboxDispatcher = dependencies.createSandboxDispatcher({ acquisitionPort });
	} catch (error: unknown) {
		await operationActiveUseRuntime.retire().catch(() => undefined);
		await publishedBindingRuntime.close().catch(() => undefined);
		throw error;
	}
	let retirementPromise: Promise<void> | undefined;
	const retire = (): Promise<void> =>
		(retirementPromise ??= (async (): Promise<void> => {
			const failures: unknown[] = [];
			try {
				await sandboxDispatcher.retire();
			} catch (error: unknown) {
				failures.push(error);
			}
			try {
				await operationActiveUseRuntime.retire();
			} catch (error: unknown) {
				failures.push(error);
			}
			try {
				await publishedBindingRuntime.close();
			} catch (error: unknown) {
				failures.push(error);
			}
			if (failures.length > 0) {
				throw new AggregateError(failures, 'Gateway Runtime production control retirement failed.');
			}
		})());
	const toolVmRunnerBackendPortFactory: GatewayRuntimeManagedToolPortalBackendPortFactories['toolVmRunner'] =
		(artifactRuntime) => {
			try {
				const capabilityCatalog = dependencies.compileConfiguredCatalog(props.toolPortalConfig);
				const artifactWriter = dependencies.createArtifactWriter({
					artifactStore: artifactRuntime.artifactStore,
					lifetimeMs: props.artifactLifetimeMs,
					registerArtifactAuthority: artifactRuntime.registerArtifactAuthority,
				});
				return dependencies.createToolVmRunnerBackendPort({
					acquisitionPort,
					artifactWriter,
					capabilityCatalog,
				});
			} catch (error: unknown) {
				void retire().catch(() => undefined);
				throw error;
			}
		};
	return {
		acquisitionPort,
		approvalPort,
		approvalDecisionOperations,
		applicationMessageHandler,
		controllerExecutionBackendPortFactory: () => controllerExecutionBackendPort,
		oauthAvailabilityPort,
		retire,
		sandboxDispatch: sandboxDispatcher.dispatch,
		toolVmRunnerBackendPortFactory,
	};
}
