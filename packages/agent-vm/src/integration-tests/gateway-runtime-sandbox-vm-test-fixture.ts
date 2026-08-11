import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
	SandboxOperationIdentity,
	SandboxProcessHandle,
	SandboxProcessStatusResult,
	SandboxStreamHandle,
	SandboxTerminalOutcome,
} from '@agent-vm/agent-portal-sdk';
import {
	GatewayRuntimeClient,
	type GatewayRuntimeAttachmentMetadata,
	type GatewayRuntimeClientTrustedInvocationContext,
} from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import type { ToolPortalBackendKind, ToolPortalConfig } from '@agent-vm/config-contracts';
import {
	deriveGatewayControlStablePrincipal,
	type GatewayRuntimePortalSemanticSnapshot,
	type GatewayRuntimeToolPortalDispatchAuthorityForBackendKind,
} from '@agent-vm/gateway-control-contracts';
import {
	createGatewayRuntimeManagedToolPortalComposition,
	createGatewayRuntimePaths,
	createGatewayRuntimePrivateUdsDispatcher,
	createGatewayRuntimeProductionSandboxDispatcher,
	createGatewayRuntimeSandboxOperationAuthority,
	createGatewayRuntimeSandboxProcessRegistry,
	createGatewayRuntimeToolVmRunnerBackendPort,
	createManagedPluginAttachmentState,
	createStrictToolVmSshClient,
	createStrictToolVmSshTransport,
	GATEWAY_RUNTIME_AUTHENTICATED_PRIVATE_UDS_OPERATION_GROUPS,
	gatewayRuntimeArtifactStablePrincipalFromTrustedContext,
	resolveGatewayRuntimeOperationGroup,
	startGatewayRuntimeUdsServer,
	type GatewayRuntimeArtifactAuthorization,
	type GatewayRuntimeArtifactProjectionOperations,
	type GatewayRuntimeManagedToolPortalComposition,
	type GatewayRuntimePortalProjectionOperations,
	type GatewayRuntimePrivateUdsProjectionFactoryProps,
	type GatewayRuntimeProductionSandboxDispatcher,
	type GatewayRuntimeSandboxOperationContext,
	type GatewayRuntimeToolVmRunnerArtifactWriteRequest,
	type GatewayRuntimeToolVmRunnerBoundSandbox,
	type GatewayRuntimeToolVmRunnerCapabilityCatalog,
	type GatewayRuntimeToolVmRunnerOperationGroup,
	type GatewayRuntimeToolVmRunnerOperationGroupAcquisitionPort,
	type GatewayRuntimeUdsServer,
	type StrictToolVmSshClient,
	type StrictToolVmSshProcessChannel,
	type StrictToolVmSshProcessChannelClient,
	type StrictToolVmSshTerminalSize,
} from '@agent-vm/gateway-runtime';
import type { ManagedVm, ManagedVmSshAccess } from '@agent-vm/managed-vm';
import { createStaticSecretResolver } from '@agent-vm/secret-management';
import { type ToolPortalApprovalPort, type ToolPortalBackendPort } from '@agent-vm/tool-portal';

import { runBuildCommand } from '../cli/build-command.js';
import { createManagedVmRuntimeComposition } from '../composition/gondolin-managed-vm-provider.js';
import { createToolVm } from '../tool-vm/tool-vm-lifecycle.js';
import {
	currentE2eArchitecture,
	prepareGatewayE2eProjectImages,
	removeE2eTempRoot,
	scaffoldOpenClawE2eProject,
} from './e2e-harness.js';

const zoneId = 'gateway-runtime-sandbox';
const gatewayEnvironmentGeneration = 'gateway:zone-sandbox:epoch-1';
const gatewayProfileAssignmentRevision = 'sandbox-profile-assignment-1';
const stockProjectionCohortDigest =
	'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const stockProofCapabilityName = 'write_configured_proof';
const stockDisposableRootfsProofFileName = 'replacement-rootfs-proof.txt';
const stockDisposableRootfsProofGuestPath = `/work/${stockDisposableRootfsProofFileName}`;
const stockHostToGuestWorkspaceFileName = 'host-to-guest-workspace-coherence.txt';
const stockGuestToHostWorkspaceFileName = 'guest-to-host-workspace-coherence.txt';
const stockGuestRootfsFileName = 'guest-rootfs-only.txt';
const stockReplacementWorkspaceProofGuestPath = '/workspace/replacement-persistence.txt';
const stockHostToGuestWorkspaceContent = 'host-workspace-visible-at-workspace';
const stockGuestToHostWorkspaceContent = 'guest-workspace-visible-at-host-workspace';
const stockGuestRootfsContent = 'guest-rootfs-visible-only-at-work';

const stockProofTrustedInvocationContext = {
	correlation: {
		runId: 'stock-sandbox-run',
		sessionId: 'stock-sandbox-session',
		toolCallId: 'stock-sandbox-tool-call',
	},
	principal: {
		agentId: 'gateway-agent',
		frameworkIdentity: { agentId: 'gateway-agent', kind: 'openclaw' },
		profileAssignmentRevision: gatewayProfileAssignmentRevision,
		toolPortalProfileId: 'sandbox-user',
	},
	requester: { authenticatedSubjectId: 'openclaw:gateway-agent' },
} satisfies GatewayRuntimeClientTrustedInvocationContext;

const stockProofManagedPluginAttachment = {
	attachmentGeneration: 1,
	clientKind: 'openclaw-managed-plugin',
	configuredAgentIds: [stockProofTrustedInvocationContext.principal.agentId],
	frameworkEpoch: 'stock-sandbox-framework-epoch-1',
	gatewayEpoch: 'stock-sandbox-gateway-epoch-1',
	protocolVersion: 1,
	projectionCohortDigest: stockProjectionCohortDigest,
	runtimeEpoch: 'stock-sandbox-runtime-epoch-1',
	schemaVersion: 1,
} satisfies GatewayRuntimeAttachmentMetadata;

const stockProofCapabilityCatalog = {
	'sandbox-user': [
		{
			descriptor: {
				annotations: {},
				inputSchema: { additionalProperties: false, properties: {}, type: 'object' },
				name: stockProofCapabilityName,
				namespace: 'sandbox',
				outputSchema: { additionalProperties: false, type: 'object' },
				related: [],
				toolRef: `sandbox.${stockProofCapabilityName}`,
			},
			operation: {
				argv: ['/bin/sh', '-c', 'printf %s stock-vm > proof.txt; printf %s stock-vm-output'],
				cwd: '',
				kind: 'exec',
			},
			summary: {
				description: 'Write deterministic stock-VM proof content using configured execution.',
				input: { optional: [], propertyCount: 0, required: [], type: 'object' },
				name: stockProofCapabilityName,
				namespace: 'sandbox',
				output: { optional: [], propertyCount: 2, required: [], type: 'object' },
				safety: { readOnlyHint: false },
				toolRef: `sandbox.${stockProofCapabilityName}`,
			},
		},
	],
} as const satisfies GatewayRuntimeToolVmRunnerCapabilityCatalog;

interface TransportEvidence {
	readonly strictHostKeyVerified: boolean;
	readonly strictSshPayloadByteCount: number;
}

interface StockSandboxProcessHandle {
	cancel(): Promise<{ readonly kind: 'cancel-requested' | 'stale-process-handle' }>;
	status(): Promise<{ readonly kind: 'running' | 'stale-process-handle' }>;
	write(bytes: Uint8Array): Promise<{ readonly kind: 'stale-process-handle' | 'written' }>;
}

interface StockCancellableSshOperation {
	wait(): Promise<{ readonly kind: 'cancelled' }>;
}

interface StockSandbox {
	append(path: string, contents: string): Promise<void>;
	readFile(path: string): Promise<string>;
	startCancellableSshOperation(readinessPath: string): Promise<StockCancellableSshOperation>;
	startWriter(path: string): Promise<StockSandboxProcessHandle>;
}

interface StockSandboxPredecessorContainment {
	readonly managedVmCloseCompleted: true;
	readonly oldEndpointReconnectRejected: true;
	readonly oldStrictSshClientRejected: true;
}

interface StockSandboxReplacement {
	readonly predecessorContainment: StockSandboxPredecessorContainment;
	readonly predecessorCredentialRejectedBySuccessor: true;
	readonly predecessorQuiescence: 'proven';
	readonly sameWorkspaceMountReusedAfterContainment: boolean;
	readonly successor: StockSandbox;
}

export interface StockGatewayRuntimeSandboxVmHarness {
	acquireSandbox(): Promise<StockSandbox>;
	appendReplacementWorkspaceProof(contents: string): Promise<void>;
	disposableRootfsProofExists(): Promise<boolean>;
	dispose(): Promise<void>;
	gatewayRuntimeClient(): GatewayRuntimeClient;
	hostWorkspaceContainsDisposableRootfsProof(): Promise<boolean>;
	proveWorkspaceRootfsSeparation(): Promise<StockWorkspaceRootfsEvidence>;
	readToolVmFile(path: string): Promise<string>;
	readReplacementWorkspaceProof(): Promise<string>;
	replaceToolVmLeaf(): Promise<StockSandboxReplacement>;
	transportEvidence(): TransportEvidence;
	trustedInvocationContext(): GatewayRuntimeClientTrustedInvocationContext;
	writeDisposableRootfsProof(): Promise<void>;
}

export interface StockWorkspaceRootfsEvidence {
	readonly authorityAbsence: {
		readonly guestAgentPathAbsent: boolean;
		readonly guestSelfPathAbsent: boolean;
		readonly guestWholeZonePathAbsent: boolean;
	};
	readonly guestRootfs: {
		readonly content: string;
		readonly guestPath: string;
	};
	readonly guestToHostWorkspace: {
		readonly content: string;
		readonly hostFilePath: string;
	};
	readonly hostToGuestWorkspace: {
		readonly content: string;
		readonly guestPath: string;
	};
	readonly hostWorkspaceRoot: string;
	readonly storageSeparation: {
		readonly guestWorkMissingHostWorkspaceFile: boolean;
		readonly hostWorkspaceMissingGuestWorkFile: boolean;
	};
}

interface ActiveToolVmLeaf {
	readonly acquireOperationGroup: () => GatewayRuntimeToolVmRunnerOperationGroup;
	activeSshOperation:
		| {
				readonly abortController: AbortController;
				readonly completion: Promise<{ readonly kind: 'cancelled' }>;
		  }
		| undefined;
	readonly binding: GatewayRuntimeToolVmRunnerBoundSandbox;
	readonly generation: number;
	readonly hostWorkspaceRoot: string;
	readonly identityPem: string;
	readonly operationGroupAuthorities: Set<
		ReturnType<typeof createGatewayRuntimeSandboxOperationAuthority>
	>;
	readonly sandbox: StockSandbox;
	readonly sshAccess: ManagedVmSshAccess;
	readonly vm: ManagedVm;
	retired: boolean;
}

interface StockPrivateUdsProjection {
	readonly artifactOperations: GatewayRuntimeArtifactProjectionOperations;
	readonly portalOperations: GatewayRuntimePortalProjectionOperations;
}

interface StockWriterProcess {
	readonly processId: number;
	readonly readyRelativePath: string;
	readonly releaseRelativePath: string;
	readonly targetRelativePath: string;
}

interface StockDirectShellProcess {
	readonly channel: StrictToolVmSshProcessChannel;
	readonly operation: SandboxOperationIdentity;
	readonly process: SandboxProcessHandle;
	readonly stderr: SandboxStreamHandle;
	readonly stderrChunks: Uint8Array[];
	readonly stdin: SandboxStreamHandle;
	readonly stdout: SandboxStreamHandle;
	readonly stdoutChunks: Uint8Array[];
	readonly terminalPromise: Promise<void>;
	readonly terminalSize: StrictToolVmSshTerminalSize | undefined;
	terminalExitCode: number | undefined;
	terminalOutcome: SandboxTerminalOutcome | undefined;
}

function directShellStatus(record: StockDirectShellProcess): SandboxProcessStatusResult {
	return record.terminalOutcome === undefined
		? { kind: 'running', operation: record.operation, process: record.process }
		: {
				kind: 'terminal',
				operation: record.operation,
				outcome: record.terminalOutcome,
				process: record.process,
			};
}

function directShellChannelBytes(
	record: StockDirectShellProcess,
	channel: 'stderr' | 'stdout',
): Buffer {
	return Buffer.concat(
		(channel === 'stdout' ? record.stdoutChunks : record.stderrChunks).map((bytes) =>
			Buffer.from(bytes),
		),
	);
}

function relativeWorkPath(requestedPath: string): string {
	if (requestedPath === '/work') return '';
	if (!requestedPath.startsWith('/work/')) {
		throw new Error(`Stock sandbox paths must be beneath /work: ${requestedPath}`);
	}
	return requestedPath.slice('/work/'.length);
}

function isMissingFileError(error: unknown): boolean {
	return (
		error instanceof Error &&
		'code' in error &&
		typeof error.code === 'string' &&
		error.code === 'ENOENT'
	);
}

async function hostFileExists(filePath: string): Promise<boolean> {
	try {
		await readFile(filePath);
		return true;
	} catch (error: unknown) {
		if (isMissingFileError(error)) return false;
		throw error;
	}
}

async function operationIsRejected(operation: () => Promise<unknown>): Promise<boolean> {
	try {
		await operation();
		return false;
	} catch {
		return true;
	}
}

async function retireToolVmLeaf(
	leaf: ActiveToolVmLeaf,
): Promise<StockSandboxPredecessorContainment> {
	if (leaf.retired) {
		return {
			managedVmCloseCompleted: true,
			oldEndpointReconnectRejected: true,
			oldStrictSshClientRejected: true,
		};
	}
	leaf.retired = true;
	leaf.binding.operationAuthority.beginReplacement({ replacementLeafGeneration: 'retired' });
	for (const operationGroupAuthority of leaf.operationGroupAuthorities) {
		operationGroupAuthority.beginReplacement({ replacementLeafGeneration: 'retired' });
	}
	leaf.operationGroupAuthorities.clear();
	leaf.activeSshOperation?.abortController.abort(
		new Error('Predecessor Tool VM authority was fenced.'),
	);
	if (leaf.activeSshOperation !== undefined) await leaf.activeSshOperation.completion;
	leaf.binding.strictSshClient.close();
	await leaf.sshAccess.close();
	await leaf.vm.close();
	const oldStrictSshClientRejected = await operationIsRejected(
		async () =>
			await leaf.binding.strictSshClient.execute({
				argv: ['/bin/sh', '-c', 'printf forbidden > stale-client.txt'],
				cwd: '',
			}),
	);
	const oldEndpointClient = createStrictSshClient({
		connectDeadlineMilliseconds: 5_000,
		identityPem: leaf.identityPem,
		sshAccess: leaf.sshAccess,
	});
	const oldEndpointReconnectRejected = await operationIsRejected(
		async () => await oldEndpointClient.connect(),
	);
	oldEndpointClient.close();
	if (!oldStrictSshClientRejected || !oldEndpointReconnectRejected) {
		throw new Error('Awaited ManagedVm.close() did not contain predecessor Tool VM access.');
	}
	return {
		managedVmCloseCompleted: true,
		oldEndpointReconnectRejected: true,
		oldStrictSshClientRejected: true,
	};
}

async function successorRejectsPredecessorCredential(options: {
	readonly predecessorIdentityPem: string;
	readonly successorSshAccess: ManagedVmSshAccess;
}): Promise<true> {
	const expectedSuccessorHostKey = Buffer.from(
		options.successorSshAccess.serverHostKey.publicKeyBase64,
		'base64',
	);
	const sshTransport = createStrictToolVmSshTransport();
	return await new Promise<true>((resolve, reject) => {
		let settled = false;
		const connectDeadline = setTimeout(() => {
			if (settled) return;
			settled = true;
			sshTransport.destroy();
			reject(new Error('Predecessor credential probe against successor SSH timed out.'));
		}, 5_000);
		const finish = (): boolean => {
			if (settled) return false;
			settled = true;
			clearTimeout(connectDeadline);
			return true;
		};
		sshTransport.once('ready', () => {
			if (!finish()) return;
			sshTransport.end();
			reject(new Error('Successor Tool VM accepted the predecessor SSH credential.'));
		});
		sshTransport.once('error', (error: Error) => {
			if (!finish()) return;
			sshTransport.destroy();
			const errorLevel = 'level' in error ? error.level : undefined;
			if (errorLevel !== 'client-authentication') {
				reject(
					new Error(
						`Predecessor credential probe failed outside SSH authentication: ${String(errorLevel)}`,
						{ cause: error },
					),
				);
				return;
			}
			resolve(true);
		});
		sshTransport.connect({
			algorithms: { serverHostKey: ['ssh-ed25519'] },
			host: options.successorSshAccess.host,
			hostVerifier: (presentedHostKey: Buffer): boolean =>
				presentedHostKey.equals(expectedSuccessorHostKey),
			port: options.successorSshAccess.port,
			privateKey: options.predecessorIdentityPem,
			username: options.successorSshAccess.user,
		});
	});
}

function createUnusedBackendPort<TBackendKind extends ToolPortalBackendKind>(
	backendKind: TBackendKind,
): ToolPortalBackendPort<TBackendKind> {
	const reject = (): Promise<never> =>
		Promise.reject(
			new Error(`${backendKind} backend was not expected in the stock sandbox proof.`),
		);
	return { backendKind, call: reject, describe: reject, list: reject, search: reject };
}

function toolVmDispatchOperationId(
	authority: GatewayRuntimeToolPortalDispatchAuthorityForBackendKind<'tool_vm_runner'>,
): string {
	return authority.kind === 'without-approval'
		? authority.operationId
		: authority.grant.operationId;
}

function toolVmDispatchFingerprint(
	authority: GatewayRuntimeToolPortalDispatchAuthorityForBackendKind<'tool_vm_runner'>,
): string {
	return authority.kind === 'without-approval'
		? authority.fingerprint
		: authority.grant.fingerprint;
}

function toolVmArtifactAuthorization(
	request: GatewayRuntimeToolVmRunnerArtifactWriteRequest,
): GatewayRuntimeArtifactAuthorization {
	return {
		...gatewayRuntimeArtifactStablePrincipalFromTrustedContext(request.trustedContext),
		capability: request.capability,
		executionFingerprint: toolVmDispatchFingerprint(request.dispatchAuthority),
		operationId: toolVmDispatchOperationId(request.dispatchAuthority),
		owningGeneration: request.owningGeneration,
		surfaceClass: request.surfaceClass,
	};
}

function createPrivateUdsProjection(
	props: GatewayRuntimePrivateUdsProjectionFactoryProps,
): StockPrivateUdsProjection {
	return {
		artifactOperations: props.artifactOperations,
		portalOperations: props.portalOperations,
	};
}

function createStrictSshClient(options: {
	readonly connectDeadlineMilliseconds?: number;
	readonly identityPem: string;
	readonly sshAccess: ManagedVmSshAccess;
}): StrictToolVmSshClient & StrictToolVmSshProcessChannelClient {
	return createStrictToolVmSshClient({
		access: {
			host: options.sshAccess.host,
			identityPem: options.identityPem,
			knownHostsLine: `${options.sshAccess.host} ${options.sshAccess.serverHostKey.algorithm} ${options.sshAccess.serverHostKey.publicKeyBase64}`,
			port: options.sshAccess.port,
			user: options.sshAccess.user,
		},
		deadlineMilliseconds: {
			connect: options.connectDeadlineMilliseconds ?? 15_000,
			operation: 30_000,
		},
		limits: {
			maxDirectoryEntries: 256,
			maxFileBytes: 1_048_576,
			maxPathDepth: 16,
			maxStderrBytes: 65_536,
			maxStdoutBytes: 1_048_576,
			maxSymlinkDepth: 8,
			maxWriteBytes: 1_048_576,
		},
		runtime: {
			clock: { now: () => performance.now() },
			createSshClient: createStrictToolVmSshTransport,
			scheduler: {
				schedule: (callback, delayMilliseconds) => {
					const timeout = setTimeout(callback, delayMilliseconds);
					return { cancel: () => clearTimeout(timeout) };
				},
			},
		},
	});
}

export async function createStockGatewayRuntimeSandboxVmHarness(): Promise<StockGatewayRuntimeSandboxVmHarness> {
	const project = await scaffoldOpenClawE2eProject({
		agents: ['gateway-agent'],
		architecture: currentE2eArchitecture(),
		prefix: 'gateway-runtime-sandbox-vm-e2e-',
		zoneId,
	});
	try {
		await prepareGatewayE2eProjectImages({
			project,
			runBuild: async ({ systemConfig }) => {
				await runBuildCommand({
					skipObservability: true,
					systemConfig: {
						...systemConfig,
						imageProfiles: {
							...systemConfig.imageProfiles,
							gateways: {},
						},
					},
				});
			},
		});
	} catch (error: unknown) {
		await removeE2eTempRoot(project.tempRoot);
		throw error;
	}
	const systemZone = project.systemConfig.zones[0];
	if (systemZone === undefined || systemZone.gateway.type !== 'openclaw') {
		await removeE2eTempRoot(project.tempRoot);
		throw new Error('Stock sandbox proof requires one OpenClaw zone.');
	}
	const toolVmProfile = project.systemConfig.toolVmProfiles.standard;
	if (toolVmProfile === undefined) {
		await removeE2eTempRoot(project.tempRoot);
		throw new Error('Stock sandbox proof requires the standard Tool VM profile.');
	}
	const zoneFilesDir = systemZone.gateway.zoneFilesDir;
	const runtimeComposition = createManagedVmRuntimeComposition();
	const udsRuntimeRoot = await mkdtemp('/tmp/agent-vm-sandbox-uds-');
	const sharedHostGitDirectoryRoot = path.join(
		systemZone.gateway.zoneRuntimeDir,
		'gitdirs',
		'agents',
		'gateway-agent',
	);
	const sharedHostWorkspaceRoot = path.join(zoneFilesDir, 'agents', 'gateway-agent');
	await Promise.all([
		mkdir(sharedHostGitDirectoryRoot, { recursive: true }),
		mkdir(sharedHostWorkspaceRoot, { recursive: true }),
	]);
	let generation = 0;
	let strictSshPayloadByteCount = 0;
	let strictHostKeyVerified = false;
	let activeLeaf: ActiveToolVmLeaf | undefined;
	let disposed = false;
	let managedToolPortalComposition:
		| GatewayRuntimeManagedToolPortalComposition<StockPrivateUdsProjection>
		| undefined;
	let udsServer: GatewayRuntimeUdsServer | undefined;
	let gatewayRuntimeClient: GatewayRuntimeClient | undefined;
	let productionSandboxDispatcher: GatewayRuntimeProductionSandboxDispatcher | undefined;

	const createLeaf = async (): Promise<ActiveToolVmLeaf> => {
		generation += 1;
		const hostWorkspaceRoot = sharedHostWorkspaceRoot;
		const vm = await createToolVm(
			{
				agentId: 'gateway-agent',
				cacheDir: project.systemConfig.cacheDir,
				profile: toolVmProfile,
				rootBinding: {
					hostGitDirectoryRoot: sharedHostGitDirectoryRoot,
					hostWorkspaceRoot,
					kind: 'managed-agent-workspace',
				},
				secretResolver: createStaticSecretResolver({}),
				systemConfig: project.systemConfig,
				tcpSlot: 0,
				zoneId,
			},
			runtimeComposition,
		);
		let sshAccess: ManagedVmSshAccess | undefined;
		try {
			sshAccess = await vm.enableSsh({ user: 'root' });
			const identityPem = await readFile(sshAccess.identityFile, 'utf8');
			const sshClient = createStrictSshClient({ identityPem, sshAccess });
			await sshClient.connect();
			strictHostKeyVerified = true;
			const operationContext = {
				activeUseId: `stock-active-use-${String(generation)}`,
				environmentGeneration: gatewayEnvironmentGeneration,
				gatewayEpoch: stockProofManagedPluginAttachment.gatewayEpoch,
				leafGeneration: `stock-leaf-generation-${String(generation)}`,
				leaseId: `stock-lease-${String(generation)}`,
				sshBindingId: `stock-ssh-binding-${String(generation)}`,
				stablePrincipal: deriveGatewayControlStablePrincipal({
					principal: stockProofTrustedInvocationContext.principal,
				}),
			} as const satisfies GatewayRuntimeSandboxOperationContext;
			const operationAuthority = createGatewayRuntimeSandboxOperationAuthority(operationContext);
			const writerProcesses = new Map<string, StockWriterProcess>();
			const directShellProcesses = new Map<string, StockDirectShellProcess>();
			const directShellStreams = new Map<
				string,
				{ readonly processHandleId: string; readonly stream: SandboxStreamHandle }
			>();
			const requireWriterProcess = (handleToken: string): StockWriterProcess => {
				const writerProcess = writerProcesses.get(handleToken);
				if (writerProcess === undefined) {
					throw new Error('Stock sandbox writer handle is unknown.');
				}
				return writerProcess;
			};
			const requireDirectShellProcess = (handleToken: string): StockDirectShellProcess => {
				const directShellProcess = directShellProcesses.get(handleToken);
				if (directShellProcess === undefined) {
					throw new Error('Stock sandbox direct-shell handle is unknown.');
				}
				return directShellProcess;
			};
			const streamsByProcessHandle = new Map<string, SandboxStreamHandle>();
			const processRuntime: Parameters<
				typeof createGatewayRuntimeSandboxProcessRegistry
			>[0]['processRuntime'] = {
				cancel: ({ process }) => {
					const directShellProcess = directShellProcesses.get(process.handleId);
					if (directShellProcess !== undefined) {
						directShellProcess.channel.requestCancellation();
						return {
							kind: 'cancel-request-accepted',
							operation: directShellProcess.operation,
						};
					}
					requireWriterProcess(process.handleId);
					return {
						kind: 'cancel-request-accepted',
						operation: {
							operationId: `stock-cancel-${process.handleId}`,
							owningGeneration: operationContext.environmentGeneration,
						},
					};
				},
				closeStream: ({ stream }) => {
					const directShellStream = directShellStreams.get(stream.handleId);
					if (directShellStream !== undefined) {
						if (directShellStream.stream.channel !== 'stdin') {
							throw new Error('Stock sandbox output streams cannot be closed as input.');
						}
						requireDirectShellProcess(directShellStream.processHandleId).channel.endInput();
					}
					return { kind: 'closed', stream };
				},
				logs: ({ process, maxBytes }) => {
					const directShellProcess = directShellProcesses.get(process.handleId);
					if (directShellProcess !== undefined) {
						const stdout = directShellChannelBytes(directShellProcess, 'stdout');
						const selected = stdout.subarray(0, maxBytes);
						return {
							chunks:
								selected.byteLength === 0
									? []
									: [
											{
												channel: 'stdout',
												chunk: {
													byteLength: selected.byteLength,
													contentBase64: selected.toString('base64'),
													encoding: 'base64',
												},
												sequence: 0,
											},
										],
							kind: 'logs',
							process,
							truncated: selected.byteLength < stdout.byteLength,
						};
					}
					requireWriterProcess(process.handleId);
					return { chunks: [], kind: 'logs', process, truncated: maxBytes < 1 };
				},
				read: ({ maxBytes, stream }) => {
					const directShellStream = directShellStreams.get(stream.handleId);
					if (directShellStream !== undefined) {
						const directShellProcess = requireDirectShellProcess(directShellStream.processHandleId);
						if (directShellStream.stream.channel === 'stdin') {
							throw new Error('Stock sandbox stdin is not readable.');
						}
						if (directShellStream.stream.channel === 'pty') {
							throw new Error('Stock sandbox direct shell does not expose a combined PTY stream.');
						}
						const bytes = directShellChannelBytes(
							directShellProcess,
							directShellStream.stream.channel,
						).subarray(0, maxBytes);
						return {
							chunk: {
								byteLength: bytes.byteLength,
								contentBase64: bytes.toString('base64'),
								encoding: 'base64',
							},
							eof: directShellProcess.terminalOutcome !== undefined,
							kind: 'read',
							sequence: 0,
							stream,
						};
					}
					return {
						chunk: { byteLength: 0, contentBase64: '', encoding: 'base64' },
						eof: false,
						kind: 'read',
						sequence: 0,
						stream,
					};
				},
				retire: async (): Promise<void> => {
					for (const directShellProcess of directShellProcesses.values()) {
						if (directShellProcess.terminalOutcome === undefined) {
							directShellProcess.channel.requestCancellation();
						}
					}
					writerProcesses.clear();
					streamsByProcessHandle.clear();
					directShellProcesses.clear();
					directShellStreams.clear();
				},
				start: async (startRequest) => {
					const requestedPath = startRequest.argv[1];
					if (startRequest.argv[0] !== 'stock-background-writer' || requestedPath === undefined) {
						throw new Error('Stock sandbox background capability is not configured.');
					}
					const targetRelativePath = relativeWorkPath(requestedPath);
					const readyRelativePath = `${targetRelativePath}.writer-ready`;
					const releaseRelativePath = `${targetRelativePath}.release`;
					const writerStart = await sshClient.execute({
						argv: [
							'/bin/sh',
							'-c',
							'nohup /bin/sh -c \'printf "%s\\n" pre-fence-a > "$1"; : > "$2"; while [ ! -e "$3" ]; do :; done; printf "%s\\n" post-fence-a >> "$1"\' stock-writer "$1" "$2" "$3" </dev/null >/dev/null 2>&1 & printf "%s" "$!"',
							'stock-writer-launcher',
							targetRelativePath,
							readyRelativePath,
							releaseRelativePath,
						],
						cwd: '',
					});
					strictSshPayloadByteCount +=
						writerStart.stdout.byteLength + writerStart.stderr.byteLength;
					const processId = Number.parseInt(Buffer.from(writerStart.stdout).toString('utf8'), 10);
					if (writerStart.exitCode !== 0 || !Number.isSafeInteger(processId)) {
						throw new Error('Strict SSH predecessor writer did not start.');
					}
					const process = {
						handleId: `stock-writer-${randomUUID()}`,
						kind: 'process',
						owningGeneration: operationContext.environmentGeneration,
					} as const satisfies SandboxProcessHandle;
					const stdin = {
						channel: 'stdin',
						handleId: `stock-writer-stdin-${randomUUID()}`,
						kind: 'stream',
						owningGeneration: operationContext.environmentGeneration,
					} as const satisfies SandboxStreamHandle;
					writerProcesses.set(process.handleId, {
						processId,
						readyRelativePath,
						releaseRelativePath,
						targetRelativePath,
					});
					streamsByProcessHandle.set(process.handleId, stdin);
					return {
						kind: 'started',
						operation: {
							operationId: `stock-start-${process.handleId}`,
							owningGeneration: operationContext.environmentGeneration,
						},
						process,
						streams: [stdin],
					};
				},
				startShell: async (startRequest) => {
					const process = {
						handleId: `stock-shell-${randomUUID()}`,
						kind: 'process',
						owningGeneration: operationContext.environmentGeneration,
					} as const satisfies SandboxProcessHandle;
					const operation = {
						operationId: `stock-shell-start-${process.handleId}`,
						owningGeneration: operationContext.environmentGeneration,
					} as const satisfies SandboxOperationIdentity;
					const stdin = {
						channel: 'stdin',
						handleId: `stock-shell-stdin-${randomUUID()}`,
						kind: 'stream',
						owningGeneration: operationContext.environmentGeneration,
					} as const satisfies SandboxStreamHandle;
					const stdout = {
						channel: 'stdout',
						handleId: `stock-shell-stdout-${randomUUID()}`,
						kind: 'stream',
						owningGeneration: operationContext.environmentGeneration,
					} as const satisfies SandboxStreamHandle;
					const stderr = {
						channel: 'stderr',
						handleId: `stock-shell-stderr-${randomUUID()}`,
						kind: 'stream',
						owningGeneration: operationContext.environmentGeneration,
					} as const satisfies SandboxStreamHandle;
					const stdoutChunks: Uint8Array[] = [];
					const stderrChunks: Uint8Array[] = [];
					const terminal = Promise.withResolvers<void>();
					let terminalOutcome: SandboxTerminalOutcome | undefined;
					let terminalExitCode: number | undefined;
					const channel = await sshClient.openShellProcessChannel({
						command: startRequest.command,
						cwd: startRequest.cwd,
						...(startRequest.environmentVariables === undefined
							? {}
							: { environmentVariables: startRequest.environmentVariables }),
						onStderr: (bytes) => stderrChunks.push(bytes),
						onStdout: (bytes) => stdoutChunks.push(bytes),
						onTerminal: (event) => {
							terminalExitCode = event.kind === 'exited' ? event.exitCode : undefined;
							terminalOutcome =
								event.kind === 'ambiguous'
									? {
											certainty: 'side-effects-and-termination-unknown',
											kind: 'ambiguous',
											retryClass: 'forbidden',
										}
									: {
											certainty: 'proven',
											completion: event.exitCode === 0 ? 'succeeded' : 'failed',
											kind: 'completed',
											retryClass: 'forbidden',
										};
							terminal.resolve();
						},
						...(startRequest.terminalSize === undefined
							? {}
							: { terminalSize: startRequest.terminalSize }),
					});
					const directShellProcess: StockDirectShellProcess = {
						channel,
						operation,
						process,
						stderr,
						stderrChunks,
						stdin,
						stdout,
						stdoutChunks,
						terminalExitCode,
						terminalOutcome,
						terminalPromise: terminal.promise,
						terminalSize: startRequest.terminalSize,
					};
					directShellProcesses.set(process.handleId, directShellProcess);
					for (const stream of [stdin, stdout, stderr]) {
						directShellStreams.set(stream.handleId, {
							processHandleId: process.handleId,
							stream,
						});
					}
					void terminal.promise.then(() => {
						directShellProcess.terminalExitCode = terminalExitCode;
						directShellProcess.terminalOutcome = terminalOutcome;
						strictSshPayloadByteCount +=
							directShellChannelBytes(directShellProcess, 'stdout').byteLength +
							directShellChannelBytes(directShellProcess, 'stderr').byteLength;
					});
					return { kind: 'started', operation, process, streams: [stdin, stdout, stderr] };
				},
				resizeTerminal: ({ process, size }) => {
					const directShellProcess = requireDirectShellProcess(process.handleId);
					if (directShellProcess.terminalSize === undefined) {
						throw new Error('Stock sandbox direct shell did not allocate a terminal.');
					}
					directShellProcess.channel.resizeTerminal(size);
				},
				status: ({ process }) => {
					const directShellProcess = directShellProcesses.get(process.handleId);
					if (directShellProcess !== undefined) return directShellStatus(directShellProcess);
					requireWriterProcess(process.handleId);
					return {
						kind: 'running',
						operation: {
							operationId: `stock-status-${process.handleId}`,
							owningGeneration: operationContext.environmentGeneration,
						},
						process,
					};
				},
				terminalExitCode: ({ process }) =>
					directShellProcesses.get(process.handleId)?.terminalExitCode,
				wait: async ({ process, timeoutMs }) => {
					const directShellProcess = directShellProcesses.get(process.handleId);
					if (directShellProcess !== undefined) {
						if (directShellProcess.terminalOutcome === undefined) {
							await Promise.race([
								directShellProcess.terminalPromise,
								new Promise<void>((resolve) => {
									const deadline = setTimeout(resolve, timeoutMs);
									deadline.unref?.();
								}),
							]);
						}
						return directShellStatus(directShellProcess);
					}
					requireWriterProcess(process.handleId);
					return {
						kind: 'running',
						operation: {
							operationId: `stock-wait-${process.handleId}`,
							owningGeneration: operationContext.environmentGeneration,
						},
						process,
					};
				},
				write: async (request) => {
					const directShellStream = directShellStreams.get(request.stream.handleId);
					if (directShellStream !== undefined) {
						if (directShellStream.stream.channel !== 'stdin') {
							throw new Error('Stock sandbox output streams are not writable.');
						}
						const directShellProcess = requireDirectShellProcess(directShellStream.processHandleId);
						const bytes = Buffer.from(request.content.contentBase64, 'base64');
						await directShellProcess.channel.write(bytes);
						strictSshPayloadByteCount += bytes.byteLength;
						return {
							bytesWritten: bytes.byteLength,
							kind: 'written',
							sequence: request.sequence,
							stream: request.stream,
						};
					}
					const processEntry = [...streamsByProcessHandle.entries()].find(
						([, stream]) => stream.handleId === request.stream.handleId,
					);
					if (processEntry === undefined) throw new Error('Stock writer stream is unknown.');
					const writerProcess = requireWriterProcess(processEntry[0]);
					const bytes = Buffer.from(request.content.contentBase64, 'base64');
					await sshClient.writeFile({ bytes, path: writerProcess.releaseRelativePath });
					strictSshPayloadByteCount += bytes.byteLength;
					return {
						bytesWritten: bytes.byteLength,
						kind: 'written',
						sequence: request.sequence,
						stream: request.stream,
					};
				},
			};
			const processRegistry = createGatewayRuntimeSandboxProcessRegistry({
				operationAuthority,
				operationContext,
				processRuntime,
			});
			let operationGroupSequence = 0;
			const operationGroupAuthorities = new Set<
				ReturnType<typeof createGatewayRuntimeSandboxOperationAuthority>
			>();
			const acquireOperationGroup = (): GatewayRuntimeToolVmRunnerOperationGroup => {
				operationGroupSequence += 1;
				const groupOperationContext = {
					...operationContext,
					activeUseId: `${operationContext.activeUseId}:group:${String(operationGroupSequence)}`,
				} satisfies GatewayRuntimeSandboxOperationContext;
				const groupOperationAuthority =
					createGatewayRuntimeSandboxOperationAuthority(groupOperationContext);
				operationGroupAuthorities.add(groupOperationAuthority);
				const groupProcessRegistry = createGatewayRuntimeSandboxProcessRegistry({
					operationAuthority: groupOperationAuthority,
					operationContext: groupOperationContext,
					processRuntime,
				});
				let activeUseEndPromise: Promise<void> | undefined;
				let retirementPromise: Promise<void> | undefined;
				const endActiveUse = (): Promise<void> => (activeUseEndPromise ??= Promise.resolve());
				const retireGroup = (): Promise<void> =>
					(retirementPromise ??= (async (): Promise<void> => {
						groupOperationAuthority.beginReplacement({ replacementLeafGeneration: 'retired' });
						operationGroupAuthorities.delete(groupOperationAuthority);
						await Promise.all([endActiveUse(), groupProcessRegistry.retire()]);
					})());
				return {
					endActiveUse: async () => await endActiveUse(),
					environmentGeneration: gatewayEnvironmentGeneration,
					kind: 'bound',
					operationAuthority: groupOperationAuthority,
					operationContext: groupOperationContext,
					processRegistry: groupProcessRegistry,
					retireGroup: async () => await retireGroup(),
					strictSshClient: sshClient,
				};
			};
			const leaf: Omit<ActiveToolVmLeaf, 'sandbox'> = {
				acquireOperationGroup,
				activeSshOperation: undefined,
				binding: {
					environmentGeneration: gatewayEnvironmentGeneration,
					kind: 'bound',
					operationAuthority,
					operationContext,
					processRegistry,
					strictSshClient: sshClient,
				},
				generation,
				hostWorkspaceRoot,
				identityPem,
				operationGroupAuthorities,
				retired: false,
				sshAccess,
				vm,
			};
			const completedLeafState: { current: ActiveToolVmLeaf | undefined } = {
				current: undefined,
			};
			const requireCompletedLeaf = (): ActiveToolVmLeaf => {
				if (completedLeafState.current === undefined) {
					throw new Error('Stock sandbox Tool VM leaf is not initialized.');
				}
				return completedLeafState.current;
			};
			const requireCurrent = (): void => {
				const currentLeaf = requireCompletedLeaf();
				if (currentLeaf.retired || activeLeaf?.generation !== currentLeaf.generation) {
					throw new Error('stale generation: predecessor Tool VM leaf is retired');
				}
			};
			const sandbox: StockSandbox = {
				append: async (requestedPath, contents) => {
					requireCurrent();
					const relativePath = relativeWorkPath(requestedPath);
					const execution = await sshClient.execute({
						argv: ['/usr/bin/tee', '-a', relativePath],
						cwd: '',
						stdin: Buffer.from(contents),
					});
					strictSshPayloadByteCount +=
						Buffer.byteLength(contents) + execution.stdout.byteLength + execution.stderr.byteLength;
					if (execution.exitCode !== 0) throw new Error('Strict SSH append failed.');
				},
				readFile: async (requestedPath) => {
					requireCurrent();
					try {
						const bytes = await sshClient.readFile({ path: relativeWorkPath(requestedPath) });
						strictSshPayloadByteCount += bytes.byteLength;
						return Buffer.from(bytes).toString('utf8');
					} catch (error: unknown) {
						throw new Error(`Strict SSH stock sandbox read failed for ${requestedPath}.`, {
							cause: error,
						});
					}
				},
				startCancellableSshOperation: async (readinessPath) => {
					requireCurrent();
					const currentLeaf = requireCompletedLeaf();
					if (currentLeaf.activeSshOperation !== undefined) {
						throw new Error('Stock sandbox cancellable SSH operation is already active.');
					}
					const readinessRelativePath = relativeWorkPath(readinessPath);
					const abortController = new AbortController();
					const completion = sshClient
						.execute({
							argv: [
								'/bin/sh',
								'-c',
								': > "$1"; while :; do :; done',
								'stock-active-ssh-operation',
								readinessRelativePath,
							],
							cwd: '',
							signal: abortController.signal,
						})
						.then(
							(): never => {
								throw new Error('Stock sandbox cancellable SSH operation exited unexpectedly.');
							},
							(error: unknown): { readonly kind: 'cancelled' } => {
								if (
									error instanceof Error &&
									error.message === 'Strict SSH operation was cancelled.'
								) {
									return { kind: 'cancelled' };
								}
								throw new Error('Stock sandbox active SSH operation failed before cancellation.', {
									cause: error,
								});
							},
						);
					void completion.catch((): void => undefined);
					currentLeaf.activeSshOperation = { abortController, completion };
					const readiness = await sshClient.execute({
						argv: [
							'/bin/sh',
							'-c',
							'while [ ! -e "$1" ]; do :; done',
							'stock-active-ssh-readiness',
							readinessRelativePath,
						],
						cwd: '',
					});
					strictSshPayloadByteCount += readiness.stdout.byteLength + readiness.stderr.byteLength;
					if (readiness.exitCode !== 0) {
						throw new Error('Strict SSH cancellable operation readiness failed.');
					}
					return { wait: async () => await completion };
				},
				startWriter: async (requestedPath) => {
					requireCurrent();
					const started = await processRegistry.start({
						argv: ['stock-background-writer', requestedPath],
						cwd: '',
						maxRuntimeMs: 30_000,
						retainOutputBytes: 4_096,
					});
					const stdin = started.streams.find((stream) => stream.channel === 'stdin');
					if (stdin === undefined) throw new Error('Stock writer stdin stream was not created.');
					const relativePath = relativeWorkPath(requestedPath);
					const readiness = await sshClient.execute({
						argv: [
							'/bin/sh',
							'-c',
							'while [ ! -e "$1" ]; do :; done',
							'stock-writer-readiness',
							`${relativePath}.writer-ready`,
						],
						cwd: '',
					});
					strictSshPayloadByteCount += readiness.stdout.byteLength + readiness.stderr.byteLength;
					if (
						readiness.exitCode !== 0 ||
						processRegistry.status({ process: started.process }).kind !== 'running'
					) {
						throw new Error('Strict SSH predecessor writer readiness failed.');
					}
					let writeSequence = 0;
					return {
						cancel: async () => {
							try {
								processRegistry.cancel({ process: started.process });
								return { kind: 'cancel-requested' };
							} catch {
								return { kind: 'stale-process-handle' };
							}
						},
						status: async () => {
							try {
								processRegistry.status({ process: started.process });
								return { kind: 'running' };
							} catch {
								return { kind: 'stale-process-handle' };
							}
						},
						write: async (bytes) => {
							try {
								await processRegistry.write({
									content: {
										byteLength: bytes.byteLength,
										contentBase64: Buffer.from(bytes).toString('base64'),
										encoding: 'base64',
									},
									contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
									sequence: writeSequence,
									stream: stdin,
								});
								writeSequence += 1;
								return { kind: 'written' };
							} catch {
								return { kind: 'stale-process-handle' };
							}
						},
					};
				},
			};
			completedLeafState.current = { ...leaf, sandbox };
			return completedLeafState.current;
		} catch (error) {
			await sshAccess?.close();
			await vm.close();
			throw error;
		}
	};

	try {
		activeLeaf = await createLeaf();
		const toolPortalConfig = {
			agents: { 'gateway-agent': { profile: 'sandbox-user' } },
			mode: 'managed',
			profiles: {
				'sandbox-user': {
					namespaces: {
						sandbox: {
							backend: {
								kind: 'tool_vm_runner',
								operations: {
									[stockProofCapabilityName]: {
										description:
											'Write deterministic stock-VM proof content using configured execution.',
										executable: '/bin/sh',
										kind: 'command.fixed',
										mandatoryArgvPrefix: [
											'-c',
											'printf %s stock-vm > proof.txt; printf %s stock-vm-output',
										],
										workingDirectory: '.',
									},
								},
								profile: 'sandbox_ssh',
							},
							calls: {
								requiresApproval: { allow: [], deny: [] },
								withoutApproval: { allow: [stockProofCapabilityName], deny: [] },
							},
							tools: { allow: [stockProofCapabilityName], deny: [] },
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
					profileAssignmentRevision: gatewayProfileAssignmentRevision,
					toolPortalNamespaceNames: ['sandbox'],
					toolPortalProfileId: 'sandbox-user',
				},
			},
			bindingRevision: 'sandbox-binding-1',
			catalogRevision: 'sandbox-catalog-1',
			desiredRevision: 'sandbox-semantic-1',
			profilePolicyRevision: 'sandbox-policy-1',
			projectionCohortDigest: stockProjectionCohortDigest,
			providerRevision: 'sandbox-provider-1',
			schemaRevision: 'sandbox-schema-1',
			schemaVersion: 1,
			surfaceEligibilityByProfile: { 'sandbox-user': { sandbox: ['protected_uds'] } },
		} satisfies GatewayRuntimePortalSemanticSnapshot;
		const approvalPort = {
			armDispatch: (): Promise<never> =>
				Promise.reject(new Error('Stock sandbox proof capability does not require approval.')),
			reserveDispatch: (): Promise<never> =>
				Promise.reject(new Error('Stock sandbox proof capability does not require approval.')),
		} satisfies ToolPortalApprovalPort;
		const acquisitionPort = {
			acquire: async (request) => {
				const leaf = activeLeaf;
				if (
					leaf === undefined ||
					leaf.retired ||
					request.trustedContext.principal.agentId !== 'gateway-agent' ||
					request.trustedContext.principal.frameworkIdentity.kind !== 'openclaw' ||
					request.trustedContext.principal.frameworkIdentity.agentId !== 'gateway-agent' ||
					request.trustedContext.principal.profileAssignmentRevision !==
						gatewayProfileAssignmentRevision ||
					request.trustedContext.principal.toolPortalProfileId !== 'sandbox-user'
				) {
					return {
						kind: 'not-bound',
						owningGeneration: gatewayEnvironmentGeneration,
						reason: leaf === undefined ? 'unavailable' : 'not-authorized',
					};
				}
				if (
					leaf.binding.operationAuthority.authorize(leaf.binding.operationContext).kind !==
					'authorized'
				) {
					return {
						kind: 'not-bound',
						owningGeneration: leaf.binding.environmentGeneration,
						reason: 'stale-generation',
					};
				}
				return leaf.acquireOperationGroup();
			},
		} satisfies GatewayRuntimeToolVmRunnerOperationGroupAcquisitionPort;
		managedToolPortalComposition = await createGatewayRuntimeManagedToolPortalComposition({
			approvalPort,
			artifactRuntime: {
				artifactsDirectoryPath: path.join(udsRuntimeRoot, 'artifacts'),
				epochId: stockProofManagedPluginAttachment.runtimeEpoch,
				limits: {
					maximumArtifactBytes: 1_048_576,
					maximumArtifactCount: 16,
					maximumLifetimeMs: 60_000,
					maximumTotalBytes: 4_194_304,
				},
				now: Date.now,
			},
			authenticatedPrivateUdsOperationGroups:
				GATEWAY_RUNTIME_AUTHENTICATED_PRIVATE_UDS_OPERATION_GROUPS,
			backendPortFactories: {
				controllerHostAction: () => createUnusedBackendPort('controller_host_action'),
				mcpProvider: () => createUnusedBackendPort('mcp_provider'),
				toolVmRunner: (artifactRuntime) =>
					createGatewayRuntimeToolVmRunnerBackendPort({
						artifactWriter: {
							write: async (request) => {
								strictSshPayloadByteCount += request.bytes.byteLength;
								const authorization = toolVmArtifactAuthorization(request);
								const registration = artifactRuntime.registerArtifactAuthority(authorization);
								if (registration.kind !== 'registered') {
									throw new Error('Stock sandbox artifact authority registration failed.');
								}
								const writeHandle = await artifactRuntime.artifactStore.beginWrite({
									authorization,
									lifetimeMs: 60_000,
									maximumBytes: Math.max(1, request.bytes.byteLength),
									mediaType: request.mediaType,
								});
								try {
									await writeHandle.write(request.bytes);
									return await writeHandle.commit();
								} catch (error: unknown) {
									await writeHandle.abort();
									throw error;
								}
							},
						},
						acquisitionPort,
						capabilityCatalog: stockProofCapabilityCatalog,
					}),
			},
			createPrivateUdsProjection,
			managedPluginAttachment: {
				clientKind: stockProofManagedPluginAttachment.clientKind,
				configuredAgentIds: stockProofManagedPluginAttachment.configuredAgentIds,
				projectionCohortDigest: stockProofManagedPluginAttachment.projectionCohortDigest,
			},
			semanticSnapshot,
			toolPortalConfig,
		});
		productionSandboxDispatcher = createGatewayRuntimeProductionSandboxDispatcher({
			acquisitionPort,
		});
		const privateUdsDispatcher = createGatewayRuntimePrivateUdsDispatcher({
			artifactOperations: managedToolPortalComposition.privateUdsProjection.artifactOperations,
			portalOperations: managedToolPortalComposition.privateUdsProjection.portalOperations,
			sandboxDispatch: productionSandboxDispatcher.dispatch,
		});
		const udsPaths = createGatewayRuntimePaths({ runtimeRoot: udsRuntimeRoot });
		udsServer = await startGatewayRuntimeUdsServer({
			attachmentState: createManagedPluginAttachmentState({
				attachmentGeneration: stockProofManagedPluginAttachment.attachmentGeneration,
				clientKind: stockProofManagedPluginAttachment.clientKind,
				configuredAgentIds: stockProofManagedPluginAttachment.configuredAgentIds,
				frameworkEpoch: stockProofManagedPluginAttachment.frameworkEpoch,
				gatewayEpoch: stockProofManagedPluginAttachment.gatewayEpoch,
				projectionCohortDigest: stockProofManagedPluginAttachment.projectionCohortDigest,
				runtimeEpoch: stockProofManagedPluginAttachment.runtimeEpoch,
				serverAuthority: {
					allowedOperationGroups: GATEWAY_RUNTIME_AUTHENTICATED_PRIVATE_UDS_OPERATION_GROUPS,
					surface: 'managed-plugin',
				},
			}),
			dispatch: privateUdsDispatcher.dispatch,
			paths: udsPaths,
			resolveOperationGroup: resolveGatewayRuntimeOperationGroup,
		});
		gatewayRuntimeClient = new GatewayRuntimeClient({
			attachment: stockProofManagedPluginAttachment,
			socketPath: udsServer.readiness.socketPath,
			startupRetryPolicy: { maxAttempts: 1 },
		});
		await gatewayRuntimeClient.connect();
	} catch (error) {
		if (activeLeaf !== undefined) await retireToolVmLeaf(activeLeaf);
		await gatewayRuntimeClient?.disconnect();
		await udsServer?.retire();
		await productionSandboxDispatcher?.retire();
		await managedToolPortalComposition?.retireEpoch();
		await rm(udsRuntimeRoot, { force: true, recursive: true });
		await removeE2eTempRoot(project.tempRoot);
		throw error;
	}

	return {
		acquireSandbox: async () => {
			if (activeLeaf === undefined) throw new Error('Stock sandbox Tool VM is unavailable.');
			return activeLeaf.sandbox;
		},
		appendReplacementWorkspaceProof: async (contents) => {
			if (activeLeaf === undefined) throw new Error('Stock sandbox Tool VM is unavailable.');
			const result = await activeLeaf.vm.exec(
				['/usr/bin/tee', '-a', stockReplacementWorkspaceProofGuestPath],
				{ stdin: contents },
			);
			if (result.exitCode !== 0) {
				throw new Error(
					`Stock sandbox durable workspace proof write failed: ${result.stderr || result.stdout}`,
				);
			}
		},
		disposableRootfsProofExists: async () => {
			if (activeLeaf === undefined) throw new Error('Stock sandbox Tool VM is unavailable.');
			const result = await activeLeaf.vm.exec(`test -f ${stockDisposableRootfsProofGuestPath}`);
			return result.exitCode === 0;
		},
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			const cleanupResults = await Promise.allSettled([
				(async (): Promise<void> => {
					await gatewayRuntimeClient?.disconnect();
					await udsServer?.retire();
					await productionSandboxDispatcher?.retire();
					await managedToolPortalComposition?.retireEpoch();
				})(),
				activeLeaf === undefined ? Promise.resolve() : retireToolVmLeaf(activeLeaf),
			]);
			await Promise.all([
				rm(udsRuntimeRoot, { force: true, recursive: true }),
				removeE2eTempRoot(project.tempRoot),
			]);
			const cleanupErrors = cleanupResults
				.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
				.map((result) => result.reason as unknown);
			if (cleanupErrors.length > 0) {
				throw new AggregateError(cleanupErrors, 'Stock sandbox proof cleanup failed.');
			}
		},
		gatewayRuntimeClient: () => {
			if (gatewayRuntimeClient === undefined) {
				throw new Error('Gateway runtime private-UDS client is unavailable.');
			}
			return gatewayRuntimeClient;
		},
		hostWorkspaceContainsDisposableRootfsProof: async () =>
			await hostFileExists(path.join(sharedHostWorkspaceRoot, stockDisposableRootfsProofFileName)),
		proveWorkspaceRootfsSeparation: async () => {
			if (activeLeaf === undefined) throw new Error('Stock sandbox Tool VM is unavailable.');
			const hostToGuestWorkspaceFilePath = path.join(
				sharedHostWorkspaceRoot,
				stockHostToGuestWorkspaceFileName,
			);
			const guestToHostWorkspaceFilePath = path.join(
				sharedHostWorkspaceRoot,
				stockGuestToHostWorkspaceFileName,
			);
			const hostToGuestWorkspaceGuestPath = `/workspace/${stockHostToGuestWorkspaceFileName}`;
			const guestToHostWorkspaceGuestPath = `/workspace/${stockGuestToHostWorkspaceFileName}`;
			const guestRootfsPath = `/work/${stockGuestRootfsFileName}`;

			await writeFile(hostToGuestWorkspaceFilePath, stockHostToGuestWorkspaceContent, 'utf8');
			const hostWorkspaceReadFromGuest = await activeLeaf.vm.exec(
				`/bin/cat ${hostToGuestWorkspaceGuestPath}`,
			);
			if (hostWorkspaceReadFromGuest.exitCode !== 0) {
				throw new Error(
					`Stock sandbox host-to-guest workspace read failed: ${hostWorkspaceReadFromGuest.stderr}`,
				);
			}

			const guestWorkspaceWrite = await activeLeaf.vm.exec(
				['/usr/bin/tee', '-a', guestToHostWorkspaceGuestPath],
				{ stdin: stockGuestToHostWorkspaceContent },
			);
			if (guestWorkspaceWrite.exitCode !== 0) {
				throw new Error(
					`Stock sandbox guest-to-host workspace write failed: ${guestWorkspaceWrite.stderr || guestWorkspaceWrite.stdout}`,
				);
			}
			await activeLeaf.sandbox.append(guestRootfsPath, stockGuestRootfsContent);

			const [guestAgentProbe, guestSelfProbe, guestWholeZoneProbe] = await Promise.all([
				activeLeaf.vm.exec('test ! -e /agent'),
				activeLeaf.vm.exec('test ! -e /self'),
				activeLeaf.vm.exec('test ! -e /zone'),
			]);
			const guestWorkHostWorkspaceProbe = await activeLeaf.vm.exec(
				`test ! -e /work/${stockHostToGuestWorkspaceFileName}`,
			);

			return {
				authorityAbsence: {
					guestAgentPathAbsent: guestAgentProbe.exitCode === 0,
					guestSelfPathAbsent: guestSelfProbe.exitCode === 0,
					guestWholeZonePathAbsent: guestWholeZoneProbe.exitCode === 0,
				},
				guestRootfs: {
					content: await activeLeaf.sandbox.readFile(guestRootfsPath),
					guestPath: guestRootfsPath,
				},
				guestToHostWorkspace: {
					content: await readFile(guestToHostWorkspaceFilePath, 'utf8'),
					hostFilePath: guestToHostWorkspaceFilePath,
				},
				hostToGuestWorkspace: {
					content: hostWorkspaceReadFromGuest.stdout,
					guestPath: hostToGuestWorkspaceGuestPath,
				},
				hostWorkspaceRoot: sharedHostWorkspaceRoot,
				storageSeparation: {
					guestWorkMissingHostWorkspaceFile: guestWorkHostWorkspaceProbe.exitCode === 0,
					hostWorkspaceMissingGuestWorkFile: !(await hostFileExists(
						path.join(sharedHostWorkspaceRoot, stockGuestRootfsFileName),
					)),
				},
			};
		},
		readToolVmFile: async (requestedPath) => {
			if (activeLeaf === undefined) throw new Error('Stock sandbox Tool VM is unavailable.');
			return await activeLeaf.sandbox.readFile(requestedPath);
		},
		readReplacementWorkspaceProof: async () => {
			if (activeLeaf === undefined) throw new Error('Stock sandbox Tool VM is unavailable.');
			const result = await activeLeaf.vm.exec([
				'/bin/cat',
				stockReplacementWorkspaceProofGuestPath,
			]);
			if (result.exitCode !== 0) {
				throw new Error(
					`Stock sandbox durable workspace proof read failed: ${result.stderr || result.stdout}`,
				);
			}
			return result.stdout;
		},
		replaceToolVmLeaf: async () => {
			const predecessor = activeLeaf;
			if (predecessor === undefined) throw new Error('Stock sandbox Tool VM is unavailable.');
			const predecessorContainment = await retireToolVmLeaf(predecessor);
			activeLeaf = undefined;
			const successor = await createLeaf();
			try {
				const predecessorCredentialRejectedBySuccessor =
					await successorRejectsPredecessorCredential({
						predecessorIdentityPem: predecessor.identityPem,
						successorSshAccess: successor.sshAccess,
					});
				activeLeaf = successor;
				return {
					predecessorContainment,
					predecessorCredentialRejectedBySuccessor,
					predecessorQuiescence: 'proven',
					sameWorkspaceMountReusedAfterContainment:
						predecessor.hostWorkspaceRoot === successor.hostWorkspaceRoot,
					successor: successor.sandbox,
				};
			} catch (error: unknown) {
				await retireToolVmLeaf(successor);
				throw error;
			}
		},
		transportEvidence: () => ({
			strictHostKeyVerified,
			strictSshPayloadByteCount,
		}),
		trustedInvocationContext: () => stockProofTrustedInvocationContext,
		writeDisposableRootfsProof: async () => {
			if (activeLeaf === undefined) throw new Error('Stock sandbox Tool VM is unavailable.');
			const result = await activeLeaf.vm.exec(
				`printf %s rootfs-a > ${stockDisposableRootfsProofGuestPath}`,
			);
			if (result.exitCode !== 0) {
				throw new Error(
					`Stock sandbox disposable rootfs proof write failed: ${result.stderr || result.stdout}`,
				);
			}
		},
	};
}
