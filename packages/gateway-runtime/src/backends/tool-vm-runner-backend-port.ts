import { Buffer } from 'node:buffer';

import {
	PortalCallRequestSchema,
	PortalDescribeRequestSchema,
	PortalListRequestSchema,
	PortalSearchRequestSchema,
	SANDBOX_MAXIMUM_IDENTIFIER_CHARACTERS,
	SandboxProcessCancelResultSchema,
	SandboxProcessLogsResultSchema,
	SandboxProcessStartResultSchema,
	SandboxProcessStatusResultSchema,
	type ArtifactReference,
	type CapabilityDescriptor,
	type CapabilitySummary,
	type JsonObject,
	type PortalCallRequest,
	type SandboxProcessHandle,
	type SandboxProcessStatusResult,
} from '@agent-vm/agent-portal-sdk';
import {
	deriveGatewayControlStablePrincipal,
	type GatewayRuntimeToolPortalDispatchAuthorityForBackendKind,
	type GatewayRuntimeTrustedInvocationContext,
} from '@agent-vm/gateway-control-contracts';
import type {
	ToolPortalBackendCallOptions,
	ToolPortalBackendPort,
	ToolPortalInvocationOptions,
} from '@agent-vm/tool-portal';
import { z } from 'zod';

import type {
	GatewayRuntimeSandboxOperationAuthority,
	GatewayRuntimeSandboxOperationContext,
} from '../sandbox/sandbox-operation-authority.js';
import type { GatewayRuntimeSandboxProcessRegistry } from '../sandbox/sandbox-process-registry.js';
import type { StrictToolVmSshClient } from '../sandbox/strict-tool-vm-ssh-client.js';
import { StrictToolVmSshProcessStartError } from '../sandbox/strict-tool-vm-ssh-process-runtime.js';
import {
	type GatewayRuntimeToolVmRunnerCallItem,
	toolVmRunnerExecutionErrorItem,
	toolVmRunnerNotDispatchedItem,
	toolVmRunnerSuccessfulCallItem,
} from './tool-vm-runner-call-results.js';
import {
	describeToolVmRunnerCatalog,
	listToolVmRunnerCatalog,
	searchToolVmRunnerCatalog,
} from './tool-vm-runner-catalog-projection.js';

export type GatewayRuntimeToolVmRunnerCapabilityOperation =
	| {
			readonly argv: readonly string[];
			readonly cwd: string;
			readonly kind: 'exec';
	  }
	| { readonly kind: 'list-directory' }
	| { readonly kind: 'process-cancel' }
	| { readonly kind: 'process-logs' }
	| {
			readonly argv: readonly string[];
			readonly cwd: string;
			readonly kind: 'process-start';
			readonly maxRuntimeMs: number;
			readonly retainOutputBytes: number;
	  }
	| { readonly kind: 'process-status' }
	| { readonly kind: 'process-wait'; readonly timeoutMs: number }
	| { readonly kind: 'read-file' }
	| { readonly kind: 'write-file' };

export interface GatewayRuntimeToolVmRunnerCapabilityCatalogEntry {
	readonly descriptor: CapabilityDescriptor;
	readonly operation: GatewayRuntimeToolVmRunnerCapabilityOperation;
	readonly summary: CapabilitySummary;
}

export type GatewayRuntimeToolVmRunnerProfileCapabilityCatalog =
	readonly GatewayRuntimeToolVmRunnerCapabilityCatalogEntry[];

export type GatewayRuntimeToolVmRunnerCapabilityCatalog = Readonly<
	Record<string, GatewayRuntimeToolVmRunnerProfileCapabilityCatalog>
>;

export type GatewayRuntimeToolVmRunnerArtifactRole = 'file' | 'stderr' | 'stdout';

export interface GatewayRuntimeToolVmRunnerArtifactWriteRequest {
	readonly bytes: Uint8Array;
	readonly capability: { readonly name: string; readonly namespace: string };
	readonly dispatchAuthority: GatewayRuntimeToolPortalDispatchAuthorityForBackendKind<'tool_vm_runner'>;
	readonly mediaType: string;
	readonly operationId: string;
	readonly owningGeneration: string;
	readonly role: GatewayRuntimeToolVmRunnerArtifactRole;
	readonly surfaceClass: ToolPortalInvocationOptions['surfaceClass'];
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
}

export interface GatewayRuntimeToolVmRunnerArtifactWriter {
	readonly write: (
		request: GatewayRuntimeToolVmRunnerArtifactWriteRequest,
	) => Promise<ArtifactReference>;
}

export interface GatewayRuntimeToolVmRunnerSandboxBindingRequest {
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
}

export interface GatewayRuntimeToolVmRunnerBoundSandbox {
	readonly environmentGeneration: string;
	readonly kind: 'bound';
	readonly operationAuthority: GatewayRuntimeSandboxOperationAuthority;
	readonly operationContext: GatewayRuntimeSandboxOperationContext;
	readonly processRegistry: GatewayRuntimeSandboxProcessRegistry;
	readonly strictSshClient: StrictToolVmSshClient;
}

export interface GatewayRuntimeToolVmRunnerOperationGroup extends GatewayRuntimeToolVmRunnerBoundSandbox {
	readonly endActiveUse: (
		reason: 'cancelled' | 'completed' | 'failed' | 'timed_out',
	) => Promise<void>;
	readonly retireGroup: (
		reason: 'cancelled' | 'completed' | 'failed' | 'timed_out',
	) => Promise<void>;
}

export interface GatewayRuntimeToolVmRunnerRejectedSandboxBinding {
	readonly kind: 'not-bound';
	readonly owningGeneration: string;
	readonly reason: 'not-authorized' | 'stale-generation' | 'unavailable';
}

export type GatewayRuntimeToolVmRunnerOperationGroupAcquisition =
	| GatewayRuntimeToolVmRunnerOperationGroup
	| GatewayRuntimeToolVmRunnerRejectedSandboxBinding;

export interface GatewayRuntimeToolVmRunnerOperationGroupAcquisitionPort {
	readonly acquire: (
		request: GatewayRuntimeToolVmRunnerSandboxBindingRequest,
	) => Promise<GatewayRuntimeToolVmRunnerOperationGroupAcquisition>;
}

export interface CreateGatewayRuntimeToolVmRunnerBackendPortProps {
	readonly acquisitionPort: GatewayRuntimeToolVmRunnerOperationGroupAcquisitionPort;
	readonly artifactWriter: GatewayRuntimeToolVmRunnerArtifactWriter;
	readonly capabilityCatalog: GatewayRuntimeToolVmRunnerCapabilityCatalog;
}

export interface GatewayRuntimeToolVmRunnerBackendPort extends ToolPortalBackendPort<'tool_vm_runner'> {
	readonly retire: () => Promise<void>;
}

interface RetainedToolVmRunnerProcessGroup {
	readonly group: GatewayRuntimeToolVmRunnerOperationGroup;
	readonly key: string;
	readonly process: SandboxProcessHandle;
	terminalTransitionPromise: Promise<void> | undefined;
}

const EmptyArgumentsSchema = z.object({}).strict();
export const MAXIMUM_TOOL_VM_RUNNER_TEXT_WRITE_BYTES = 65_536;
export const MAXIMUM_TOOL_VM_RUNNER_PROCESS_LOG_BYTES = 1_048_576;
export const MAXIMUM_TOOL_VM_RUNNER_PUBLIC_PATH_CHARACTERS = 4_096;
const MAXIMUM_TOOL_VM_RUNNER_TERMINAL_GROUPS = 32;

const WorkRelativePathSchema = z
	.string()
	.min(1)
	.max(MAXIMUM_TOOL_VM_RUNNER_PUBLIC_PATH_CHARACTERS)
	.refine(
		(value) => !value.includes('\0') && !value.startsWith('/') && !value.split('/').includes('..'),
		{ message: 'Sandbox paths must remain work-relative.' },
	);
const PathArgumentsSchema = z.object({ path: WorkRelativePathSchema }).strict();
const ProcessHandleArgumentsSchema = z
	.object({ handleToken: z.string().min(1).max(SANDBOX_MAXIMUM_IDENTIFIER_CHARACTERS) })
	.strict();
const ProcessLogsArgumentsSchema = z
	.object({
		cursor: z.string().min(1).max(SANDBOX_MAXIMUM_IDENTIFIER_CHARACTERS).optional(),
		handleToken: z.string().min(1).max(SANDBOX_MAXIMUM_IDENTIFIER_CHARACTERS),
		maxBytes: z.number().int().positive().max(MAXIMUM_TOOL_VM_RUNNER_PROCESS_LOG_BYTES),
	})
	.strict();
const WriteFileArgumentsSchema = z
	.object({
		content: z.string().max(MAXIMUM_TOOL_VM_RUNNER_TEXT_WRITE_BYTES),
		path: WorkRelativePathSchema,
	})
	.strict()
	.refine(
		(argumentsValue) =>
			Buffer.byteLength(argumentsValue.content, 'utf8') <= MAXIMUM_TOOL_VM_RUNNER_TEXT_WRITE_BYTES,
		{ message: 'Sandbox text write exceeds the UTF-8 byte limit.' },
	);

function operationIdFromDispatchAuthority(
	authority: GatewayRuntimeToolPortalDispatchAuthorityForBackendKind<'tool_vm_runner'>,
): string {
	return authority.kind === 'without-approval'
		? authority.operationId
		: authority.grant.operationId;
}

function capabilityEntryForCall(
	catalogByReference:
		| ReadonlyMap<string, GatewayRuntimeToolVmRunnerCapabilityCatalogEntry>
		| undefined,
	call: PortalCallRequest['calls'][number],
): GatewayRuntimeToolVmRunnerCapabilityCatalogEntry | undefined {
	return catalogByReference?.get(`${call.namespace}.${call.name}`);
}

function argumentsAreValid(
	operation: GatewayRuntimeToolVmRunnerCapabilityOperation,
	callArguments: JsonObject,
): boolean {
	switch (operation.kind) {
		case 'exec':
		case 'process-start':
			return EmptyArgumentsSchema.safeParse(callArguments).success;
		case 'list-directory':
		case 'read-file':
			return PathArgumentsSchema.safeParse(callArguments).success;
		case 'write-file':
			return WriteFileArgumentsSchema.safeParse(callArguments).success;
		case 'process-logs':
			return ProcessLogsArgumentsSchema.safeParse(callArguments).success;
		case 'process-cancel':
		case 'process-status':
		case 'process-wait':
			return ProcessHandleArgumentsSchema.safeParse(callArguments).success;
		default:
			return assertNeverOperation(operation);
	}
}

function assertNeverOperation(operation: never): never {
	throw new Error(`Unsupported Tool VM runner operation: ${String(operation)}`);
}

function boundSandboxIsCurrent(binding: GatewayRuntimeToolVmRunnerBoundSandbox): boolean {
	return (
		binding.environmentGeneration.length > 0 &&
		binding.environmentGeneration === binding.operationContext.environmentGeneration &&
		binding.operationAuthority.authorize(binding.operationContext).kind === 'authorized'
	);
}

function terminalReleaseReason(
	status: Extract<SandboxProcessStatusResult, { kind: 'terminal' }>,
): 'cancelled' | 'completed' | 'failed' | 'timed_out' {
	if (status.outcome.kind === 'cancelled-proven') return 'cancelled';
	if (status.outcome.kind === 'timed-out-proven') return 'timed_out';
	if (status.outcome.kind === 'completed' && status.outcome.completion === 'succeeded') {
		return 'completed';
	}
	return 'failed';
}

function artifactWriteRequest(props: {
	readonly bytes: Uint8Array;
	readonly call: PortalCallRequest['calls'][number];
	readonly mediaType: string;
	readonly operationId: string;
	readonly options: ToolPortalBackendCallOptions<'tool_vm_runner'>;
	readonly owningGeneration: string;
	readonly role: GatewayRuntimeToolVmRunnerArtifactRole;
}): GatewayRuntimeToolVmRunnerArtifactWriteRequest {
	return {
		bytes: props.bytes,
		capability: { name: props.call.name, namespace: props.call.namespace },
		dispatchAuthority: props.options.dispatchAuthority,
		mediaType: props.mediaType,
		operationId: props.operationId,
		owningGeneration: props.owningGeneration,
		role: props.role,
		surfaceClass: props.options.surfaceClass,
		trustedContext: props.options.trustedContext,
	};
}

export function createGatewayRuntimeToolVmRunnerBackendPort(
	props: CreateGatewayRuntimeToolVmRunnerBackendPortProps,
): GatewayRuntimeToolVmRunnerBackendPort {
	const catalogReferencesByProfile = new Map<
		string,
		ReadonlyMap<string, GatewayRuntimeToolVmRunnerCapabilityCatalogEntry>
	>();
	const catalogEntriesByProfile = new Map<
		string,
		GatewayRuntimeToolVmRunnerProfileCapabilityCatalog
	>();
	for (const [profileId, profileCatalog] of Object.entries(props.capabilityCatalog)) {
		if (profileId.length === 0) {
			throw new Error('Tool VM runner capability catalog contains an empty profile identifier.');
		}
		const catalogByReference = new Map<string, GatewayRuntimeToolVmRunnerCapabilityCatalogEntry>();
		for (const entry of profileCatalog) {
			const capabilityReference = `${entry.summary.namespace}.${entry.summary.name}`;
			if (
				entry.descriptor.namespace !== entry.summary.namespace ||
				entry.descriptor.name !== entry.summary.name ||
				entry.descriptor.toolRef !== entry.summary.toolRef ||
				catalogByReference.has(capabilityReference)
			) {
				throw new Error('Tool VM runner capability catalog is inconsistent or ambiguous.');
			}
			catalogByReference.set(capabilityReference, entry);
		}
		catalogReferencesByProfile.set(profileId, catalogByReference);
		catalogEntriesByProfile.set(profileId, profileCatalog);
	}
	const operationGroups = new Set<GatewayRuntimeToolVmRunnerOperationGroup>();
	const retainedProcessGroupsByKey = new Map<string, RetainedToolVmRunnerProcessGroup>();
	const terminalProcessGroupOrder: RetainedToolVmRunnerProcessGroup[] = [];
	let closed = false;
	let retirementPromise: Promise<void> | undefined;

	function processGroupKey(
		trustedContext: GatewayRuntimeTrustedInvocationContext,
		handleToken: string,
	): string {
		return `${deriveGatewayControlStablePrincipal({ principal: trustedContext.principal })}:${handleToken}`;
	}

	async function retireRetainedProcessGroup(
		record: RetainedToolVmRunnerProcessGroup,
		reason: 'cancelled' | 'completed' | 'failed' | 'timed_out',
	): Promise<void> {
		if (retainedProcessGroupsByKey.get(record.key) === record) {
			retainedProcessGroupsByKey.delete(record.key);
		}
		operationGroups.delete(record.group);
		await record.group.retireGroup(reason);
	}

	async function enforceTerminalProcessGroupLimit(): Promise<void> {
		const groupsToRetire: RetainedToolVmRunnerProcessGroup[] = [];
		while (terminalProcessGroupOrder.length > MAXIMUM_TOOL_VM_RUNNER_TERMINAL_GROUPS) {
			const oldest = terminalProcessGroupOrder.shift();
			if (oldest === undefined || retainedProcessGroupsByKey.get(oldest.key) !== oldest) continue;
			groupsToRetire.push(oldest);
		}
		await Promise.all(
			groupsToRetire.map(async (record) => await retireRetainedProcessGroup(record, 'completed')),
		);
	}

	function markProcessGroupTerminal(
		record: RetainedToolVmRunnerProcessGroup,
		status: Extract<SandboxProcessStatusResult, { kind: 'terminal' }>,
	): Promise<void> {
		if (record.terminalTransitionPromise !== undefined) return record.terminalTransitionPromise;
		record.terminalTransitionPromise = (async (): Promise<void> => {
			await record.group.endActiveUse(terminalReleaseReason(status));
			if (retainedProcessGroupsByKey.get(record.key) !== record) return;
			terminalProcessGroupOrder.push(record);
			await enforceTerminalProcessGroupLimit();
		})();
		return record.terminalTransitionPromise;
	}

	function observeProcessTerminal(
		record: RetainedToolVmRunnerProcessGroup,
		maximumWaitMs: number,
	): void {
		void (async (): Promise<void> => {
			try {
				while (retainedProcessGroupsByKey.get(record.key) === record) {
					const status = SandboxProcessStatusResultSchema.parse(
						// oxlint-disable-next-line no-await-in-loop -- each wait observes the next state of this one retained process.
						await record.group.processRegistry.wait({
							process: record.process,
							timeoutMs: maximumWaitMs,
						}),
					);
					if (status.kind !== 'terminal') continue;
					// oxlint-disable-next-line no-await-in-loop -- terminal transition must finish before this observer exits.
					await markProcessGroupTerminal(record, status);
					return;
				}
			} catch {
				await retireRetainedProcessGroup(record, 'failed');
			}
		})();
	}
	const callOne = async (
		call: PortalCallRequest['calls'][number],
		options: ToolPortalBackendCallOptions<'tool_vm_runner'>,
	): Promise<GatewayRuntimeToolVmRunnerCallItem> => {
		const operationId = operationIdFromDispatchAuthority(options.dispatchAuthority);
		const unboundGeneration = options.trustedContext.principal.profileAssignmentRevision;
		const catalogByReference = catalogReferencesByProfile.get(
			options.trustedContext.principal.toolPortalProfileId,
		);
		const catalogEntry = capabilityEntryForCall(catalogByReference, call);
		if (catalogEntry === undefined) {
			return toolVmRunnerNotDispatchedItem({
				code: 'capability_denied',
				id: call.id,
				operationId,
				owningGeneration: unboundGeneration,
				safeMessage: 'Sandbox capability is not configured.',
			});
		}
		if (!argumentsAreValid(catalogEntry.operation, call.arguments)) {
			return toolVmRunnerNotDispatchedItem({
				code: 'validation_failed',
				id: call.id,
				operationId,
				owningGeneration: unboundGeneration,
				safeMessage: 'Sandbox capability arguments are invalid.',
			});
		}
		if (options.signal?.aborted === true) {
			return toolVmRunnerNotDispatchedItem({
				code: 'execution_failed',
				id: call.id,
				operationId,
				owningGeneration: unboundGeneration,
				safeMessage: 'Sandbox capability was cancelled before dispatch.',
			});
		}

		const operation = catalogEntry.operation;
		if (
			operation.kind === 'process-cancel' ||
			operation.kind === 'process-logs' ||
			operation.kind === 'process-status' ||
			operation.kind === 'process-wait'
		) {
			const handleToken =
				operation.kind === 'process-logs'
					? ProcessLogsArgumentsSchema.parse(call.arguments).handleToken
					: ProcessHandleArgumentsSchema.parse(call.arguments).handleToken;
			const key = processGroupKey(options.trustedContext, handleToken);
			const retainedGroup = retainedProcessGroupsByKey.get(key);
			if (retainedGroup === undefined) {
				return toolVmRunnerNotDispatchedItem({
					code: 'capability_denied',
					id: call.id,
					operationId,
					owningGeneration: unboundGeneration,
					safeMessage: 'Sandbox process handle is stale or not authorized.',
				});
			}
			const binding = retainedGroup.group;
			if (closed || !boundSandboxIsCurrent(binding)) {
				await retireRetainedProcessGroup(retainedGroup, 'failed');
				return toolVmRunnerNotDispatchedItem({
					code: 'capability_denied',
					id: call.id,
					operationId,
					owningGeneration: binding.environmentGeneration,
					safeMessage: 'Sandbox process handle is stale or not authorized.',
				});
			}
			const process = retainedGroup.process;
			if (operation.kind === 'process-logs') {
				const parsedArguments = ProcessLogsArgumentsSchema.parse(call.arguments);
				let logsResult: ReturnType<GatewayRuntimeSandboxProcessRegistry['logs']>;
				try {
					logsResult = SandboxProcessLogsResultSchema.parse(
						binding.processRegistry.logs({
							channels: ['stdout', 'stderr'],
							...(parsedArguments.cursor === undefined ? {} : { cursor: parsedArguments.cursor }),
							maxBytes: parsedArguments.maxBytes,
							process,
						}),
					);
				} catch {
					await retireRetainedProcessGroup(retainedGroup, 'failed');
					return toolVmRunnerNotDispatchedItem({
						code: 'capability_denied',
						id: call.id,
						operationId,
						owningGeneration: binding.environmentGeneration,
						safeMessage: 'Sandbox process handle is stale or not authorized.',
					});
				}
				const bytesByChannel = {
					stderr: Buffer.concat(
						logsResult.chunks
							.filter((chunk) => chunk.channel === 'stderr')
							.map((chunk) => Buffer.from(chunk.chunk.contentBase64, 'base64')),
					),
					stdout: Buffer.concat(
						logsResult.chunks
							.filter((chunk) => chunk.channel === 'stdout')
							.map((chunk) => Buffer.from(chunk.chunk.contentBase64, 'base64')),
					),
				};
				const byteLength = bytesByChannel.stdout.byteLength + bytesByChannel.stderr.byteLength;
				if (
					byteLength > parsedArguments.maxBytes ||
					byteLength > MAXIMUM_TOOL_VM_RUNNER_PROCESS_LOG_BYTES
				) {
					return toolVmRunnerExecutionErrorItem({
						disposition: 'completed-failed',
						id: call.id,
						operationId,
						owningGeneration: binding.environmentGeneration,
						safeMessage: 'Sandbox process logs exceeded the requested byte bound.',
					});
				}
				try {
					const artifacts = await Promise.all(
						(['stdout', 'stderr'] as const)
							.filter((channel) => bytesByChannel[channel].byteLength > 0)
							.map(
								async (channel) =>
									await props.artifactWriter.write(
										artifactWriteRequest({
											bytes: bytesByChannel[channel],
											call,
											mediaType: 'text/plain; charset=utf-8',
											operationId,
											options,
											owningGeneration: binding.environmentGeneration,
											role: channel,
										}),
									),
							),
					);
					return toolVmRunnerSuccessfulCallItem({
						artifacts,
						id: call.id,
						operationId,
						owningGeneration: binding.environmentGeneration,
						value: {
							byteLength,
							chunkCount: logsResult.chunks.length,
							kind: 'logs',
							...(logsResult.nextCursor === undefined ? {} : { nextCursor: logsResult.nextCursor }),
							truncated: logsResult.truncated,
						},
					});
				} catch {
					return toolVmRunnerExecutionErrorItem({
						disposition: 'completed-failed',
						id: call.id,
						operationId,
						owningGeneration: binding.environmentGeneration,
						safeMessage: 'Sandbox process logs could not be persisted.',
					});
				}
			}
			try {
				const result =
					operation.kind === 'process-status'
						? SandboxProcessStatusResultSchema.parse(binding.processRegistry.status({ process }))
						: operation.kind === 'process-wait'
							? SandboxProcessStatusResultSchema.parse(
									await binding.processRegistry.wait({
										process,
										timeoutMs: operation.timeoutMs,
									}),
								)
							: SandboxProcessCancelResultSchema.parse(binding.processRegistry.cancel({ process }));
				if (result.kind === 'terminal') {
					await markProcessGroupTerminal(retainedGroup, result);
				} else if (result.kind === 'termination-proven' || result.kind === 'already-terminal') {
					const status = SandboxProcessStatusResultSchema.parse(
						binding.processRegistry.status({ process }),
					);
					if (status.kind === 'terminal') await markProcessGroupTerminal(retainedGroup, status);
				}
				return toolVmRunnerSuccessfulCallItem({
					id: call.id,
					operationId,
					owningGeneration: binding.environmentGeneration,
					value: {
						kind: result.kind,
						...('outcome' in result ? { outcome: result.outcome } : {}),
					},
				});
			} catch {
				await retireRetainedProcessGroup(retainedGroup, 'failed');
				return toolVmRunnerNotDispatchedItem({
					code: 'capability_denied',
					id: call.id,
					operationId,
					owningGeneration: binding.environmentGeneration,
					safeMessage: 'Sandbox process handle is stale or not authorized.',
				});
			}
		}

		if (closed) {
			return toolVmRunnerNotDispatchedItem({
				code: 'execution_failed',
				id: call.id,
				operationId,
				owningGeneration: unboundGeneration,
				safeMessage: 'Sandbox backend is retired.',
			});
		}
		let binding: GatewayRuntimeToolVmRunnerOperationGroupAcquisition;
		try {
			binding = await props.acquisitionPort.acquire({
				trustedContext: options.trustedContext,
			});
		} catch {
			return toolVmRunnerNotDispatchedItem({
				code: 'execution_failed',
				id: call.id,
				operationId,
				owningGeneration: unboundGeneration,
				safeMessage: 'Sandbox binding is unavailable.',
			});
		}
		if (binding.kind === 'not-bound') {
			return toolVmRunnerNotDispatchedItem({
				code: 'capability_denied',
				id: call.id,
				operationId,
				owningGeneration: binding.owningGeneration,
				safeMessage: 'Sandbox binding is not current or authorized.',
			});
		}
		operationGroups.add(binding);
		let retainOperationGroup = false;
		let retirementReason: 'completed' | 'failed' = 'failed';
		try {
			if (!boundSandboxIsCurrent(binding)) {
				return toolVmRunnerNotDispatchedItem({
					code: 'capability_denied',
					id: call.id,
					operationId,
					owningGeneration: binding.environmentGeneration,
					safeMessage: 'Sandbox generation is no longer current.',
				});
			}

			try {
				await binding.strictSshClient.connect();
			} catch {
				return toolVmRunnerNotDispatchedItem({
					code: 'execution_failed',
					id: call.id,
					operationId,
					owningGeneration: binding.environmentGeneration,
					safeMessage: 'Strict SSH binding could not be established.',
				});
			}
			if (!boundSandboxIsCurrent(binding)) {
				return toolVmRunnerNotDispatchedItem({
					code: 'capability_denied',
					id: call.id,
					operationId,
					owningGeneration: binding.environmentGeneration,
					safeMessage: 'Sandbox generation changed before dispatch.',
				});
			}

			switch (operation.kind) {
				case 'exec': {
					let execution: Awaited<ReturnType<StrictToolVmSshClient['execute']>>;
					try {
						execution = await binding.strictSshClient.execute({
							argv: operation.argv,
							cwd: operation.cwd,
							...(options.signal === undefined ? {} : { signal: options.signal }),
						});
					} catch {
						return toolVmRunnerExecutionErrorItem({
							disposition: 'ambiguous',
							id: call.id,
							operationId,
							owningGeneration: binding.environmentGeneration,
							safeMessage: 'Sandbox command dispatch outcome is ambiguous.',
						});
					}
					try {
						const stdoutArtifact = await props.artifactWriter.write(
							artifactWriteRequest({
								bytes: execution.stdout,
								call,
								mediaType: 'text/plain; charset=utf-8',
								operationId,
								options,
								owningGeneration: binding.environmentGeneration,
								role: 'stdout',
							}),
						);
						const stderrArtifact = await props.artifactWriter.write(
							artifactWriteRequest({
								bytes: execution.stderr,
								call,
								mediaType: 'text/plain; charset=utf-8',
								operationId,
								options,
								owningGeneration: binding.environmentGeneration,
								role: 'stderr',
							}),
						);
						retirementReason = 'completed';
						return toolVmRunnerSuccessfulCallItem({
							artifacts: [stdoutArtifact, stderrArtifact],
							id: call.id,
							operationId,
							owningGeneration: binding.environmentGeneration,
							value: { exitCode: execution.exitCode, kind: execution.kind },
						});
					} catch {
						return toolVmRunnerExecutionErrorItem({
							disposition: 'completed-failed',
							id: call.id,
							operationId,
							owningGeneration: binding.environmentGeneration,
							safeMessage: 'Sandbox command output could not be persisted.',
						});
					}
				}
				case 'read-file': {
					const parsedArguments = PathArgumentsSchema.parse(call.arguments);
					try {
						const bytes = await binding.strictSshClient.readFile({ path: parsedArguments.path });
						const artifact = await props.artifactWriter.write(
							artifactWriteRequest({
								bytes,
								call,
								mediaType: 'application/octet-stream',
								operationId,
								options,
								owningGeneration: binding.environmentGeneration,
								role: 'file',
							}),
						);
						retirementReason = 'completed';
						return toolVmRunnerSuccessfulCallItem({
							artifacts: [artifact],
							id: call.id,
							operationId,
							owningGeneration: binding.environmentGeneration,
							value: { byteLength: bytes.byteLength, kind: 'file' },
						});
					} catch {
						return toolVmRunnerExecutionErrorItem({
							disposition: 'completed-failed',
							id: call.id,
							operationId,
							owningGeneration: binding.environmentGeneration,
							safeMessage: 'Sandbox file read failed.',
						});
					}
				}
				case 'write-file': {
					const parsedArguments = WriteFileArgumentsSchema.parse(call.arguments);
					const bytes = Uint8Array.from(Buffer.from(parsedArguments.content, 'utf8'));
					try {
						await binding.strictSshClient.writeFile({ bytes, path: parsedArguments.path });
						retirementReason = 'completed';
						return toolVmRunnerSuccessfulCallItem({
							id: call.id,
							operationId,
							owningGeneration: binding.environmentGeneration,
							value: {
								byteLength: bytes.byteLength,
								kind: 'written',
								path: parsedArguments.path,
							},
						});
					} catch {
						return toolVmRunnerExecutionErrorItem({
							disposition: 'ambiguous',
							id: call.id,
							operationId,
							owningGeneration: binding.environmentGeneration,
							safeMessage: 'Sandbox file write dispatch outcome is ambiguous.',
						});
					}
				}
				case 'list-directory': {
					const parsedArguments = PathArgumentsSchema.parse(call.arguments);
					try {
						const entries = await binding.strictSshClient.listDirectory({
							path: parsedArguments.path,
						});
						retirementReason = 'completed';
						return toolVmRunnerSuccessfulCallItem({
							id: call.id,
							operationId,
							owningGeneration: binding.environmentGeneration,
							value: {
								entries: entries.map((entry) => ({ name: entry.filename })),
								kind: 'directory',
							},
						});
					} catch {
						return toolVmRunnerExecutionErrorItem({
							disposition: 'completed-failed',
							id: call.id,
							operationId,
							owningGeneration: binding.environmentGeneration,
							safeMessage: 'Sandbox directory listing failed.',
						});
					}
				}
				case 'process-start': {
					try {
						const started = SandboxProcessStartResultSchema.parse(
							await binding.processRegistry.start({
								argv: operation.argv,
								cwd: operation.cwd,
								maxRuntimeMs: operation.maxRuntimeMs,
								retainOutputBytes: operation.retainOutputBytes,
							}),
						);
						const key = processGroupKey(options.trustedContext, started.process.handleId);
						if (retainedProcessGroupsByKey.has(key)) {
							return toolVmRunnerExecutionErrorItem({
								disposition: 'ambiguous',
								id: call.id,
								operationId,
								owningGeneration: binding.environmentGeneration,
								safeMessage: 'Sandbox process handle collided with a retained handle.',
							});
						}
						const retainedGroup: RetainedToolVmRunnerProcessGroup = {
							group: binding,
							key,
							process: started.process,
							terminalTransitionPromise: undefined,
						};
						retainedProcessGroupsByKey.set(key, retainedGroup);
						retainOperationGroup = true;
						observeProcessTerminal(retainedGroup, operation.maxRuntimeMs);
						return toolVmRunnerSuccessfulCallItem({
							id: call.id,
							operationId,
							owningGeneration: binding.environmentGeneration,
							value: { handleToken: started.process.handleId, kind: 'started' },
						});
					} catch (error: unknown) {
						if (
							error instanceof StrictToolVmSshProcessStartError &&
							error.disposition === 'not-dispatched'
						) {
							return toolVmRunnerNotDispatchedItem({
								code: 'execution_failed',
								id: call.id,
								operationId,
								owningGeneration: binding.environmentGeneration,
								safeMessage: 'Sandbox process start was rejected before dispatch.',
							});
						}
						return toolVmRunnerExecutionErrorItem({
							disposition: 'ambiguous',
							id: call.id,
							operationId,
							owningGeneration: binding.environmentGeneration,
							safeMessage: 'Sandbox process dispatch outcome is ambiguous.',
						});
					}
				}
			}
			return assertNeverOperation(operation);
		} finally {
			if (!retainOperationGroup) {
				operationGroups.delete(binding);
				await binding.retireGroup(retirementReason);
			}
		}
	};
	const profileCatalogFor = (
		options: ToolPortalInvocationOptions,
	): GatewayRuntimeToolVmRunnerProfileCapabilityCatalog =>
		catalogEntriesByProfile.get(options.trustedContext.principal.toolPortalProfileId) ?? [];

	return {
		backendKind: 'tool_vm_runner',
		call: async (request, options) => {
			const parsedRequest = PortalCallRequestSchema.parse(request);
			const items = await Promise.all(parsedRequest.calls.map((call) => callOne(call, options)));
			return { items, ok: items.every((item) => item.status === 'ok') };
		},
		describe: async (request, options) =>
			describeToolVmRunnerCatalog(
				PortalDescribeRequestSchema.parse(request),
				profileCatalogFor(options),
			),
		list: async (request, options) =>
			listToolVmRunnerCatalog(PortalListRequestSchema.parse(request), profileCatalogFor(options)),
		retire: () => {
			if (retirementPromise !== undefined) return retirementPromise;
			closed = true;
			const groups = [...operationGroups];
			operationGroups.clear();
			retainedProcessGroupsByKey.clear();
			terminalProcessGroupOrder.length = 0;
			retirementPromise = Promise.all(
				groups.map(async (group) => await group.retireGroup('cancelled')),
			).then(() => undefined);
			return retirementPromise;
		},
		search: async (request, options) =>
			searchToolVmRunnerCatalog(
				PortalSearchRequestSchema.parse(request),
				profileCatalogFor(options),
			),
	};
}
