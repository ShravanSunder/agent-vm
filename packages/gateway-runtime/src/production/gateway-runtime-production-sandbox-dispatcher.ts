import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import {
	SandboxEnvironmentHandleRequestSchema,
	SandboxEnvironmentOpenRequestSchema,
	SandboxExecCancelRequestSchema,
	SandboxExecStartRequestSchema,
	SandboxExecWaitRequestSchema,
	SandboxFsListRequestSchema,
	SandboxFsMkdirRequestSchema,
	SandboxFsReadRequestSchema,
	SandboxFsRemoveRequestSchema,
	SandboxFsRenameRequestSchema,
	SandboxFsStatRequestSchema,
	SandboxFsWriteRequestSchema,
	SandboxProcessCancelRequestSchema,
	SandboxProcessHandleRequestSchema,
	SandboxProcessLogsRequestSchema,
	SandboxProcessStartRequestSchema,
	SandboxProcessWaitRequestSchema,
	SandboxRetainedResultLookupRequestSchema,
	SandboxStreamCloseRequestSchema,
	SandboxStreamReadRequestSchema,
	SandboxStreamWriteRequestSchema,
	SandboxTerminalAttachRequestSchema,
	SandboxTerminalResizeRequestSchema,
	type GatewayRuntimeTrustedInvocationContext,
	type SandboxEnvironmentHandle,
	type SandboxOperationIdentity,
	type SandboxProcessHandle,
	type SandboxProcessStartResult,
	type SandboxTerminalHandle,
} from '@agent-vm/agent-portal-sdk';
import { deriveGatewayControlStablePrincipal } from '@agent-vm/gateway-control-contracts';

import type {
	GatewayRuntimeToolVmRunnerBoundSandbox,
	GatewayRuntimeToolVmRunnerOperationGroup,
	GatewayRuntimeToolVmRunnerOperationGroupAcquisitionPort,
} from '../backends/tool-vm-runner-backend-port.js';
import { createGatewayRuntimeSandboxEnvironmentRuntime } from '../sandbox/sandbox-environment-runtime.js';
import type { GatewayRuntimeSandboxDispatchRequest } from './gateway-runtime-private-uds-dispatcher.js';
import {
	removeBoundedSandboxFilesystemTree,
	requireSandboxFilesystemWriteLength,
	resolveSandboxFilesystemPath,
	throwIfSandboxFilesystemMutationAborted,
	throwIfSandboxFilesystemRequestAborted,
} from './gateway-runtime-production-sandbox-filesystem.js';

interface ExecProcessAuthority {
	readonly process: SandboxProcessHandle;
	readonly publicOperation: SandboxOperationIdentity;
}

interface PendingTerminalReservation {
	readonly expiresAt: NodeJS.Timeout;
	readonly request: ReturnType<typeof SandboxExecStartRequestSchema.parse>;
	readonly terminal: SandboxTerminalHandle;
}

interface TerminalProcessAuthority extends ExecProcessAuthority {
	readonly terminal: SandboxTerminalHandle;
}

interface SandboxEnvironmentGroupRuntime {
	activeDescendantDispatchCount: number;
	readonly acquisition: GatewayRuntimeToolVmRunnerOperationGroup;
	readonly descendantDrainWaiters: Set<() => void>;
	readonly environments: ReturnType<typeof createGatewayRuntimeSandboxEnvironmentRuntime>;
	readonly execProcessesByOperationId: Map<string, ExecProcessAuthority>;
	readonly pendingTerminalsByOperationId: Map<string, PendingTerminalReservation>;
	readonly principalKey: string;
	retirementPromise: Promise<void> | undefined;
	readonly terminalProcessesByHandleId: Map<string, TerminalProcessAuthority>;
}

interface SandboxFilesystemEntry {
	readonly byteLength: number;
	readonly kind: 'directory' | 'file' | 'symlink';
	readonly path: string;
}

export interface GatewayRuntimeProductionSandboxDispatcher {
	readonly dispatch: (request: GatewayRuntimeSandboxDispatchRequest) => Promise<unknown>;
	readonly retire: () => Promise<void>;
}

export interface CreateGatewayRuntimeProductionSandboxDispatcherProps {
	readonly acquisitionPort: GatewayRuntimeToolVmRunnerOperationGroupAcquisitionPort;
}

function stablePrincipalKey(context: GatewayRuntimeTrustedInvocationContext): string {
	return deriveGatewayControlStablePrincipal({ principal: context.principal });
}

function bindingIsCurrent(binding: GatewayRuntimeToolVmRunnerBoundSandbox): boolean {
	return (
		binding.environmentGeneration === binding.operationContext.environmentGeneration &&
		binding.operationAuthority.authorize(binding.operationContext).kind === 'authorized'
	);
}

function operationProcessRequest(authority: ExecProcessAuthority): {
	process: SandboxProcessHandle;
} {
	return { process: authority.process };
}

function sandboxHandleKey(handle: {
	readonly handleId: string;
	readonly owningGeneration: string;
}): string {
	return `${handle.owningGeneration}\0${handle.handleId}`;
}

function sandboxOperationKey(operation: SandboxOperationIdentity): string {
	return `${operation.owningGeneration}\0${operation.operationId}`;
}

function deleteSandboxRuntimeIndexes(
	index: Map<string, SandboxEnvironmentGroupRuntime>,
	runtime: SandboxEnvironmentGroupRuntime,
): void {
	for (const [key, indexedRuntime] of index) {
		if (indexedRuntime === runtime) index.delete(key);
	}
}

function shellCwd(props: {
	readonly environmentLogicalCwd: string | undefined;
	readonly requestedCwd: string | undefined;
}): string {
	return (
		props.requestedCwd ??
		(props.environmentLogicalCwd === undefined
			? '/work'
			: path.posix.join('/work', props.environmentLogicalCwd))
	);
}

function directoryEntryKind(longname: string): 'directory' | 'file' | 'symlink' {
	return longname.startsWith('d') ? 'directory' : longname.startsWith('l') ? 'symlink' : 'file';
}

function sha256Digest(bytes: Uint8Array): string {
	return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function binaryChunk(bytes: Uint8Array): {
	readonly byteLength: number;
	readonly contentBase64: string;
	readonly encoding: 'base64';
} {
	return {
		byteLength: bytes.byteLength,
		contentBase64: Buffer.from(bytes).toString('base64'),
		encoding: 'base64',
	};
}

function isMissingGuestPathError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code: unknown = Reflect.get(error, 'code');
	return code === 2 || code === 'ENOENT' || isMissingGuestPathError(error.cause);
}

function requireFilesystemByteLength(byteLength: number): number {
	if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
		throw new Error('Sandbox filesystem returned an invalid byte length.');
	}
	return byteLength;
}

function listCursorOffset(cursor: string | undefined): number {
	if (cursor === undefined) return 0;
	const match = /^sandbox-list:(0|[1-9][0-9]*)$/u.exec(cursor);
	const offset = match === null ? Number.NaN : Number(match[1]);
	if (!Number.isSafeInteger(offset) || offset < 0) {
		throw new Error('Sandbox filesystem list cursor is invalid.');
	}
	return offset;
}

async function listGuestTree(props: {
	readonly maximumDepth: number;
	readonly maximumEntries: number;
	readonly offset: number;
	readonly rootPath: string;
	readonly signal: AbortSignal;
	readonly strictSshClient: GatewayRuntimeToolVmRunnerBoundSandbox['strictSshClient'];
}): Promise<{ readonly entries: readonly SandboxFilesystemEntry[]; readonly hasMore: boolean }> {
	const pendingDirectories: { readonly depth: number; readonly path: string }[] = [
		{ depth: 0, path: props.rootPath },
	];
	const selectedEntries: SandboxFilesystemEntry[] = [];
	let observedEntries = 0;
	while (pendingDirectories.length > 0) {
		throwIfSandboxFilesystemRequestAborted(props.signal);
		const currentDirectory = pendingDirectories.shift();
		if (currentDirectory === undefined) break;
		// oxlint-disable-next-line no-await-in-loop -- Directory traversal is ordered for stable cursors.
		const children = await props.strictSshClient.guestListDirectory({
			path: currentDirectory.path,
		});
		throwIfSandboxFilesystemRequestAborted(props.signal);
		const sortedChildren = children.toSorted((left, right) =>
			left.filename.localeCompare(right.filename),
		);
		for (const child of sortedChildren) {
			if (child.filename === '.' || child.filename === '..') continue;
			const kind = directoryEntryKind(child.longname);
			const childPath = path.posix.join(currentDirectory.path, child.filename);
			if (observedEntries >= props.offset) {
				if (selectedEntries.length === props.maximumEntries) {
					return { entries: selectedEntries, hasMore: true };
				}
				selectedEntries.push({
					byteLength: requireFilesystemByteLength(child.attrs.size),
					kind,
					path: childPath,
				});
			}
			observedEntries += 1;
			if (kind === 'directory' && currentDirectory.depth + 1 < props.maximumDepth) {
				pendingDirectories.push({ depth: currentDirectory.depth + 1, path: childPath });
			}
		}
	}
	return { entries: selectedEntries, hasMore: false };
}

function requireExecAuthority(
	runtime: SandboxEnvironmentGroupRuntime,
	operation: SandboxOperationIdentity,
): ExecProcessAuthority {
	const authority = runtime.execProcessesByOperationId.get(operation.operationId);
	if (
		authority === undefined ||
		authority.publicOperation.owningGeneration !== operation.owningGeneration
	) {
		throw new Error('Sandbox execution operation is stale or not authorized.');
	}
	return authority;
}

function beginSandboxDescendantDispatch(runtime: SandboxEnvironmentGroupRuntime): () => void {
	if (runtime.retirementPromise !== undefined) {
		throw new Error('Sandbox environment group is retiring or retired.');
	}
	runtime.activeDescendantDispatchCount += 1;
	let ended = false;
	return (): void => {
		if (ended) return;
		ended = true;
		runtime.activeDescendantDispatchCount -= 1;
		if (runtime.activeDescendantDispatchCount !== 0) return;
		for (const resolveDrain of runtime.descendantDrainWaiters) resolveDrain();
		runtime.descendantDrainWaiters.clear();
	};
}

function waitForSandboxDescendantDispatches(
	runtime: SandboxEnvironmentGroupRuntime,
): Promise<void> {
	if (runtime.activeDescendantDispatchCount === 0) return Promise.resolve();
	return new Promise<void>((resolve) => runtime.descendantDrainWaiters.add(resolve));
}

function assertNeverSandboxMethod(method: never): never {
	throw new Error(`Unsupported production Sandbox method: ${String(method)}`);
}

export function createGatewayRuntimeProductionSandboxDispatcher(
	props: CreateGatewayRuntimeProductionSandboxDispatcherProps,
): GatewayRuntimeProductionSandboxDispatcher {
	const runtimesByActiveUseId = new Map<string, SandboxEnvironmentGroupRuntime>();
	const runtimesByEnvironmentKey = new Map<string, SandboxEnvironmentGroupRuntime>();
	const runtimesByOperationKey = new Map<string, SandboxEnvironmentGroupRuntime>();
	const runtimesByProcessKey = new Map<string, SandboxEnvironmentGroupRuntime>();
	const runtimesByStreamKey = new Map<string, SandboxEnvironmentGroupRuntime>();
	const runtimesByTerminalKey = new Map<string, SandboxEnvironmentGroupRuntime>();
	let retired = false;

	const clearDescendantIndexes = (runtime: SandboxEnvironmentGroupRuntime): void => {
		deleteSandboxRuntimeIndexes(runtimesByOperationKey, runtime);
		deleteSandboxRuntimeIndexes(runtimesByProcessKey, runtime);
		deleteSandboxRuntimeIndexes(runtimesByStreamKey, runtime);
		deleteSandboxRuntimeIndexes(runtimesByTerminalKey, runtime);
		for (const reservation of runtime.pendingTerminalsByOperationId.values()) {
			clearTimeout(reservation.expiresAt);
		}
		runtime.pendingTerminalsByOperationId.clear();
		runtime.execProcessesByOperationId.clear();
		runtime.terminalProcessesByHandleId.clear();
	};

	const requireRuntimeAuthority = (options: {
		readonly allowRetired: boolean;
		readonly owningGeneration: string;
		readonly runtime: SandboxEnvironmentGroupRuntime | undefined;
		readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
	}): SandboxEnvironmentGroupRuntime => {
		if (retired) throw new Error('Gateway Runtime Sandbox dispatcher is retired.');
		const runtime = options.runtime;
		if (
			runtime === undefined ||
			runtime.principalKey !== stablePrincipalKey(options.trustedContext) ||
			runtime.acquisition.environmentGeneration !== options.owningGeneration
		) {
			throw new Error('Sandbox handle is stale or belongs to a different environment group.');
		}
		if (
			!options.allowRetired &&
			(runtime.retirementPromise !== undefined || !bindingIsCurrent(runtime.acquisition))
		) {
			throw new Error('Sandbox environment group is retired, unavailable, or stale.');
		}
		return runtime;
	};

	const runtimeForEnvironment = (
		environment: SandboxEnvironmentHandle,
		trustedContext: GatewayRuntimeTrustedInvocationContext,
		allowRetired = false,
	): SandboxEnvironmentGroupRuntime =>
		requireRuntimeAuthority({
			allowRetired,
			owningGeneration: environment.owningGeneration,
			runtime: runtimesByEnvironmentKey.get(sandboxHandleKey(environment)),
			trustedContext,
		});

	const indexStartedProcess = (
		runtime: SandboxEnvironmentGroupRuntime,
		started: SandboxProcessStartResult,
	): void => {
		const owningGeneration = runtime.acquisition.environmentGeneration;
		if (
			started.operation.owningGeneration !== owningGeneration ||
			started.process.owningGeneration !== owningGeneration ||
			started.streams.some((stream) => stream.owningGeneration !== owningGeneration)
		) {
			throw new Error('Sandbox process registry returned cross-generation descendant handles.');
		}
		runtimesByOperationKey.set(sandboxOperationKey(started.operation), runtime);
		runtimesByProcessKey.set(sandboxHandleKey(started.process), runtime);
		for (const stream of started.streams) {
			runtimesByStreamKey.set(sandboxHandleKey(stream), runtime);
		}
	};

	const retireEnvironmentGroup = (
		runtime: SandboxEnvironmentGroupRuntime,
		reason: Parameters<GatewayRuntimeToolVmRunnerOperationGroup['retireGroup']>[0],
	): Promise<void> =>
		(runtime.retirementPromise ??= (async (): Promise<void> => {
			clearDescendantIndexes(runtime);
			runtime.environments.retire();
			let retirementError: unknown;
			const drainResults = await Promise.allSettled([
				runtime.acquisition.processRegistry.retire(),
				waitForSandboxDescendantDispatches(runtime),
			]);
			for (const drainResult of drainResults) {
				if (drainResult.status === 'rejected') retirementError ??= drainResult.reason;
			}
			try {
				await runtime.acquisition.retireGroup(retirementError === undefined ? reason : 'failed');
			} catch (error: unknown) {
				retirementError ??= error;
			} finally {
				runtimesByActiveUseId.delete(runtime.acquisition.operationContext.activeUseId);
			}
			if (retirementError !== undefined) throw retirementError;
		})());

	const openEnvironment = async (
		request: GatewayRuntimeSandboxDispatchRequest,
	): Promise<unknown> => {
		if (retired) throw new Error('Gateway Runtime Sandbox dispatcher is retired.');
		const parsed = SandboxEnvironmentOpenRequestSchema.parse(request.publicRequest);
		const acquisition = await props.acquisitionPort.acquire({
			trustedContext: request.trustedContext,
		});
		if (acquisition.kind !== 'bound') {
			throw new Error('Gateway Runtime Sandbox active-use acquisition is unavailable or stale.');
		}
		if (runtimesByActiveUseId.has(acquisition.operationContext.activeUseId)) {
			throw new Error('Gateway Runtime Sandbox active-use group was acquired more than once.');
		}
		if (
			!bindingIsCurrent(acquisition) ||
			acquisition.operationContext.stablePrincipal !== stablePrincipalKey(request.trustedContext)
		) {
			await acquisition.retireGroup('failed');
			throw new Error('Gateway Runtime Sandbox active-use acquisition is unavailable or stale.');
		}
		try {
			await acquisition.strictSshClient.connect();
			if (!bindingIsCurrent(acquisition)) {
				throw new Error('Gateway Runtime Sandbox binding changed during connection.');
			}
			const environments = createGatewayRuntimeSandboxEnvironmentRuntime({
				createHandleId: randomUUID,
				maximumEnvironmentCount: 1,
				maximumTerminalTombstones: 1,
				owningGeneration: acquisition.environmentGeneration,
			});
			const opened = environments.open(parsed);
			const runtime = {
				activeDescendantDispatchCount: 0,
				acquisition,
				descendantDrainWaiters: new Set<() => void>(),
				environments,
				execProcessesByOperationId: new Map(),
				pendingTerminalsByOperationId: new Map(),
				principalKey: stablePrincipalKey(request.trustedContext),
				retirementPromise: undefined,
				terminalProcessesByHandleId: new Map(),
			} satisfies SandboxEnvironmentGroupRuntime;
			runtimesByActiveUseId.set(acquisition.operationContext.activeUseId, runtime);
			runtimesByEnvironmentKey.set(sandboxHandleKey(opened.environment), runtime);
			return opened;
		} catch (error: unknown) {
			await acquisition.retireGroup('failed').catch(() => undefined);
			throw error;
		}
	};

	const runtimeForRequest = (
		request: GatewayRuntimeSandboxDispatchRequest,
	): SandboxEnvironmentGroupRuntime => {
		const trustedContext = request.trustedContext;
		switch (request.method) {
			case 'sandbox.exec.start':
				return runtimeForEnvironment(
					SandboxExecStartRequestSchema.parse(request.publicRequest).environment,
					trustedContext,
				);
			case 'sandbox.fs.list':
				return runtimeForEnvironment(
					SandboxFsListRequestSchema.parse(request.publicRequest).environment,
					trustedContext,
				);
			case 'sandbox.fs.mkdir':
				return runtimeForEnvironment(
					SandboxFsMkdirRequestSchema.parse(request.publicRequest).environment,
					trustedContext,
				);
			case 'sandbox.fs.read':
				return runtimeForEnvironment(
					SandboxFsReadRequestSchema.parse(request.publicRequest).environment,
					trustedContext,
				);
			case 'sandbox.fs.remove':
				return runtimeForEnvironment(
					SandboxFsRemoveRequestSchema.parse(request.publicRequest).environment,
					trustedContext,
				);
			case 'sandbox.fs.rename':
				return runtimeForEnvironment(
					SandboxFsRenameRequestSchema.parse(request.publicRequest).environment,
					trustedContext,
				);
			case 'sandbox.fs.stat':
				return runtimeForEnvironment(
					SandboxFsStatRequestSchema.parse(request.publicRequest).environment,
					trustedContext,
				);
			case 'sandbox.fs.write':
				return runtimeForEnvironment(
					SandboxFsWriteRequestSchema.parse(request.publicRequest).environment,
					trustedContext,
				);
			case 'sandbox.process.start':
				return runtimeForEnvironment(
					SandboxProcessStartRequestSchema.parse(request.publicRequest).environment,
					trustedContext,
				);
			case 'sandbox.exec.cancel':
			case 'sandbox.exec.wait':
			case 'sandbox.retained-result.lookup':
			case 'sandbox.terminal.attach': {
				const operation =
					request.method === 'sandbox.exec.cancel'
						? SandboxExecCancelRequestSchema.parse(request.publicRequest).operation
						: request.method === 'sandbox.exec.wait'
							? SandboxExecWaitRequestSchema.parse(request.publicRequest).operation
							: request.method === 'sandbox.retained-result.lookup'
								? SandboxRetainedResultLookupRequestSchema.parse(request.publicRequest).operation
								: SandboxTerminalAttachRequestSchema.parse(request.publicRequest).operation;
				return requireRuntimeAuthority({
					allowRetired: false,
					owningGeneration: operation.owningGeneration,
					runtime: runtimesByOperationKey.get(sandboxOperationKey(operation)),
					trustedContext,
				});
			}
			case 'sandbox.process.cancel':
			case 'sandbox.process.logs':
			case 'sandbox.process.status':
			case 'sandbox.process.wait': {
				const process =
					request.method === 'sandbox.process.cancel'
						? SandboxProcessCancelRequestSchema.parse(request.publicRequest).process
						: request.method === 'sandbox.process.logs'
							? SandboxProcessLogsRequestSchema.parse(request.publicRequest).process
							: request.method === 'sandbox.process.status'
								? SandboxProcessHandleRequestSchema.parse(request.publicRequest).process
								: SandboxProcessWaitRequestSchema.parse(request.publicRequest).process;
				return requireRuntimeAuthority({
					allowRetired: false,
					owningGeneration: process.owningGeneration,
					runtime: runtimesByProcessKey.get(sandboxHandleKey(process)),
					trustedContext,
				});
			}
			case 'sandbox.stream.close':
			case 'sandbox.stream.read':
			case 'sandbox.stream.write': {
				const stream =
					request.method === 'sandbox.stream.close'
						? SandboxStreamCloseRequestSchema.parse(request.publicRequest).stream
						: request.method === 'sandbox.stream.read'
							? SandboxStreamReadRequestSchema.parse(request.publicRequest).stream
							: SandboxStreamWriteRequestSchema.parse(request.publicRequest).stream;
				return requireRuntimeAuthority({
					allowRetired: false,
					owningGeneration: stream.owningGeneration,
					runtime: runtimesByStreamKey.get(sandboxHandleKey(stream)),
					trustedContext,
				});
			}
			case 'sandbox.terminal.resize': {
				const terminal = SandboxTerminalResizeRequestSchema.parse(request.publicRequest).terminal;
				return requireRuntimeAuthority({
					allowRetired: false,
					owningGeneration: terminal.owningGeneration,
					runtime: runtimesByTerminalKey.get(sandboxHandleKey(terminal)),
					trustedContext,
				});
			}
			case 'sandbox.environment.close':
			case 'sandbox.environment.open':
			case 'sandbox.environment.status':
				throw new Error('Sandbox environment lifecycle request requires dedicated dispatch.');
			default:
				return assertNeverSandboxMethod(request.method);
		}
	};

	const dispatch = async (request: GatewayRuntimeSandboxDispatchRequest): Promise<unknown> => {
		if (request.method.startsWith('sandbox.fs.')) {
			throwIfSandboxFilesystemRequestAborted(request.signal);
		}
		if (request.method === 'sandbox.environment.open') return await openEnvironment(request);
		if (request.method === 'sandbox.environment.status') {
			const parsed = SandboxEnvironmentHandleRequestSchema.parse(request.publicRequest);
			const runtime = runtimeForEnvironment(parsed.environment, request.trustedContext, true);
			let status = runtime.environments.status(parsed);
			if (status.kind === 'active' && !bindingIsCurrent(runtime.acquisition)) {
				runtime.environments.retire();
				status = runtime.environments.status(parsed);
			}
			if (status.kind === 'active') {
				requireRuntimeAuthority({
					allowRetired: false,
					owningGeneration: parsed.environment.owningGeneration,
					runtime,
					trustedContext: request.trustedContext,
				});
			}
			return status;
		}
		if (request.method === 'sandbox.environment.close') {
			const parsed = SandboxEnvironmentHandleRequestSchema.parse(request.publicRequest);
			const runtime = runtimeForEnvironment(parsed.environment, request.trustedContext, true);
			const result = runtime.environments.close(parsed);
			if (result.kind === 'closed' || runtime.retirementPromise !== undefined) {
				await retireEnvironmentGroup(runtime, 'completed');
			}
			return result;
		}
		const runtime = runtimeForRequest(request);
		const processRegistry = runtime.acquisition.processRegistry;
		const endDescendantDispatch = beginSandboxDescendantDispatch(runtime);
		try {
			switch (request.method) {
				case 'sandbox.exec.start': {
					const parsed = SandboxExecStartRequestSchema.parse(request.publicRequest);
					const environment = runtime.environments.resolveActiveEnvironment(parsed.environment);
					if (parsed.mode.kind === 'attachment-reserved') {
						const publicOperation = {
							operationId: `operation:${randomUUID()}`,
							owningGeneration: runtime.acquisition.environmentGeneration,
						} satisfies SandboxOperationIdentity;
						const terminal = {
							handleId: `terminal:${randomUUID()}`,
							kind: 'terminal',
							owningGeneration: runtime.acquisition.environmentGeneration,
						} satisfies SandboxTerminalHandle;
						const expiresAt = setTimeout(() => {
							if (runtime.pendingTerminalsByOperationId.delete(publicOperation.operationId)) {
								runtimesByOperationKey.delete(sandboxOperationKey(publicOperation));
								runtimesByTerminalKey.delete(sandboxHandleKey(terminal));
							}
						}, parsed.mode.attachTimeoutMs);
						expiresAt.unref?.();
						runtime.pendingTerminalsByOperationId.set(publicOperation.operationId, {
							expiresAt,
							request: parsed,
							terminal,
						});
						runtimesByOperationKey.set(sandboxOperationKey(publicOperation), runtime);
						runtimesByTerminalKey.set(sandboxHandleKey(terminal), runtime);
						return {
							kind: 'started',
							mode: 'attachment-reserved',
							operation: publicOperation,
							terminal,
						};
					}
					const started = await processRegistry.startShell({
						command: parsed.command,
						cwd: shellCwd({
							environmentLogicalCwd: environment.logicalCwd,
							requestedCwd: parsed.cwd,
						}),
						...(parsed.environmentVariables === undefined
							? {}
							: { environmentVariables: parsed.environmentVariables }),
						maxRuntimeMs: parsed.timeoutMs,
						retainOutputBytes: 16 * 1_024 * 1_024,
					});
					indexStartedProcess(runtime, started);
					runtime.execProcessesByOperationId.set(started.operation.operationId, {
						process: started.process,
						publicOperation: started.operation,
					});
					return {
						kind: 'started',
						mode: 'direct',
						operation: started.operation,
						streams: started.streams,
					};
				}
				case 'sandbox.exec.wait': {
					const parsed = SandboxExecWaitRequestSchema.parse(request.publicRequest);
					const authority = requireExecAuthority(runtime, parsed.operation);
					const status = await processRegistry.wait({
						process: authority.process,
						timeoutMs: parsed.timeoutMs,
					});
					if (status.kind === 'running') {
						throw new Error(
							'Sandbox execution wait deadline expired while the operation is running.',
						);
					}
					const exitCode =
						status.outcome.kind === 'ambiguous'
							? undefined
							: processRegistry.terminalExitCode(operationProcessRequest(authority));
					return {
						...(exitCode === undefined ? {} : { exitCode }),
						operation: authority.publicOperation,
						outcome: status.outcome,
					};
				}
				case 'sandbox.exec.cancel': {
					const parsed = SandboxExecCancelRequestSchema.parse(request.publicRequest);
					const authority = requireExecAuthority(runtime, parsed.operation);
					const result = processRegistry.cancel(operationProcessRequest(authority));
					return { ...result, operation: authority.publicOperation };
				}
				case 'sandbox.retained-result.lookup': {
					const parsed = SandboxRetainedResultLookupRequestSchema.parse(request.publicRequest);
					const authority = runtime.execProcessesByOperationId.get(parsed.operation.operationId);
					if (
						authority === undefined ||
						authority.publicOperation.owningGeneration !== parsed.operation.owningGeneration
					) {
						return { kind: 'unavailable', reason: 'not-retained-or-not-authorized' };
					}
					const status = processRegistry.status(operationProcessRequest(authority));
					return status.kind === 'running'
						? { kind: 'pending', operation: authority.publicOperation }
						: { kind: 'retained', operation: authority.publicOperation, outcome: status.outcome };
				}
				case 'sandbox.fs.stat': {
					const parsed = SandboxFsStatRequestSchema.parse(request.publicRequest);
					const environment = runtime.environments.resolveActiveEnvironment(parsed.environment);
					const resolvedPath = resolveSandboxFilesystemPath({
						environmentLogicalCwd: environment.logicalCwd,
						operation: 'read',
						requestedPath: parsed.path,
					});
					throwIfSandboxFilesystemRequestAborted(request.signal);
					const stat = await runtime.acquisition.strictSshClient
						.guestStat({ path: resolvedPath })
						.catch((error: unknown) => {
							if (isMissingGuestPathError(error)) return undefined;
							throw error;
						});
					throwIfSandboxFilesystemRequestAborted(request.signal);
					if (stat === undefined) return { kind: 'not-found', path: resolvedPath };
					return {
						entry: {
							byteLength: stat.byteLength,
							kind: stat.kind === 'symbolic-link' ? 'symlink' : stat.kind,
							path: resolvedPath,
						},
						kind: 'stat',
					};
				}
				case 'sandbox.fs.list': {
					const parsed = SandboxFsListRequestSchema.parse(request.publicRequest);
					const environment = runtime.environments.resolveActiveEnvironment(parsed.environment);
					const resolvedPath = resolveSandboxFilesystemPath({
						environmentLogicalCwd: environment.logicalCwd,
						operation: 'read',
						requestedPath: parsed.path,
					});
					const offset = listCursorOffset(parsed.cursor);
					throwIfSandboxFilesystemRequestAborted(request.signal);
					const listing = await listGuestTree({
						maximumDepth: parsed.maxDepth,
						maximumEntries: parsed.maxEntries,
						offset,
						rootPath: resolvedPath,
						signal: request.signal,
						strictSshClient: runtime.acquisition.strictSshClient,
					});
					return {
						entries: listing.entries,
						kind: 'listed',
						...(listing.hasMore
							? { nextCursor: `sandbox-list:${String(offset + listing.entries.length)}` }
							: {}),
					};
				}
				case 'sandbox.fs.read': {
					const parsed = SandboxFsReadRequestSchema.parse(request.publicRequest);
					const environment = runtime.environments.resolveActiveEnvironment(parsed.environment);
					const resolvedPath = resolveSandboxFilesystemPath({
						environmentLogicalCwd: environment.logicalCwd,
						operation: 'read',
						requestedPath: parsed.path,
					});
					throwIfSandboxFilesystemRequestAborted(request.signal);
					const bytes = await runtime.acquisition.strictSshClient.guestReadFile({
						path: resolvedPath,
					});
					throwIfSandboxFilesystemRequestAborted(request.signal);
					const chunk = bytes.slice(parsed.offsetBytes, parsed.offsetBytes + parsed.maxBytes);
					return {
						chunk: binaryChunk(chunk),
						eof: parsed.offsetBytes + chunk.byteLength >= bytes.byteLength,
						kind: 'read',
						nextOffsetBytes: parsed.offsetBytes + chunk.byteLength,
						path: resolvedPath,
					};
				}
				case 'sandbox.fs.write': {
					const parsed = SandboxFsWriteRequestSchema.parse(request.publicRequest);
					const environment = runtime.environments.resolveActiveEnvironment(parsed.environment);
					const resolvedPath = resolveSandboxFilesystemPath({
						environmentLogicalCwd: environment.logicalCwd,
						operation: 'mutation',
						requestedPath: parsed.path,
					});
					throwIfSandboxFilesystemRequestAborted(request.signal);
					const incoming = Buffer.from(parsed.content.contentBase64, 'base64');
					let bytes = incoming;
					if (parsed.offsetBytes !== undefined) {
						requireSandboxFilesystemWriteLength({
							existingByteLength: 0,
							incomingByteLength: incoming.byteLength,
							offsetBytes: parsed.offsetBytes,
						});
						const existingStat = await runtime.acquisition.strictSshClient
							.guestStat({ path: resolvedPath })
							.catch((error: unknown) => {
								if (isMissingGuestPathError(error)) return undefined;
								throw error;
							});
						throwIfSandboxFilesystemRequestAborted(request.signal);
						requireSandboxFilesystemWriteLength({
							existingByteLength: existingStat?.byteLength ?? 0,
							incomingByteLength: incoming.byteLength,
							offsetBytes: parsed.offsetBytes,
						});
						const existing =
							existingStat === undefined
								? new Uint8Array()
								: await runtime.acquisition.strictSshClient.guestReadFile({ path: resolvedPath });
						throwIfSandboxFilesystemRequestAborted(request.signal);
						const requiredLength = requireSandboxFilesystemWriteLength({
							existingByteLength: existing.byteLength,
							incomingByteLength: incoming.byteLength,
							offsetBytes: parsed.offsetBytes,
						});
						bytes = Buffer.alloc(requiredLength);
						bytes.set(existing);
						bytes.set(incoming, parsed.offsetBytes);
					}
					const writePath = parsed.atomic
						? `${resolvedPath}.agent-vm-${randomUUID()}.tmp`
						: resolvedPath;
					try {
						await runtime.acquisition.strictSshClient.guestWriteFile({ bytes, path: writePath });
						throwIfSandboxFilesystemMutationAborted(request.signal);
						if (parsed.atomic) {
							await runtime.acquisition.strictSshClient.guestRename({
								fromPath: writePath,
								toPath: resolvedPath,
							});
							throwIfSandboxFilesystemMutationAborted(request.signal);
						}
					} catch (error: unknown) {
						if (parsed.atomic) {
							await runtime.acquisition.strictSshClient
								.guestRemove({ kind: 'file', path: writePath })
								.catch(() => undefined);
						}
						throw error;
					}
					return {
						bytesWritten: incoming.byteLength,
						contentDigest: sha256Digest(incoming),
						kind: 'written',
						path: resolvedPath,
					};
				}
				case 'sandbox.fs.mkdir': {
					const parsed = SandboxFsMkdirRequestSchema.parse(request.publicRequest);
					const environment = runtime.environments.resolveActiveEnvironment(parsed.environment);
					const resolvedPath = resolveSandboxFilesystemPath({
						environmentLogicalCwd: environment.logicalCwd,
						operation: 'mutation',
						requestedPath: parsed.path,
					});
					throwIfSandboxFilesystemRequestAborted(request.signal);
					const existedBefore = await runtime.acquisition.strictSshClient
						.guestStat({ path: resolvedPath })
						.then(
							(stat) => {
								if (stat.kind !== 'directory') {
									throw new Error('Sandbox mkdir path exists and is not a directory.');
								}
								return true;
							},
							(error: unknown) => {
								if (isMissingGuestPathError(error)) return false;
								throw error;
							},
						);
					throwIfSandboxFilesystemRequestAborted(request.signal);
					if (existedBefore) {
						return { created: false, kind: 'directory-ready', path: resolvedPath };
					}
					const paths = parsed.recursive
						? resolvedPath
								.split('/')
								.filter((component) => component.length > 0)
								.map((_, index, parts) => `/${parts.slice(0, index + 1).join('/')}`)
						: [resolvedPath];
					let mutationMayHaveApplied = false;
					for (const directoryPath of paths) {
						if (mutationMayHaveApplied) {
							throwIfSandboxFilesystemMutationAborted(request.signal);
						} else {
							throwIfSandboxFilesystemRequestAborted(request.signal);
						}
						// oxlint-disable-next-line no-await-in-loop -- Parent directories must be inspected and created in path order.
						const existingDirectory = await runtime.acquisition.strictSshClient
							.guestStat({ path: directoryPath })
							.then(
								(stat) => {
									if (stat.kind !== 'directory') {
										throw new Error('Sandbox mkdir path component is not a directory.');
									}
									return true;
								},
								(error: unknown) => {
									if (isMissingGuestPathError(error)) return false;
									throw error;
								},
							);
						if (mutationMayHaveApplied) {
							throwIfSandboxFilesystemMutationAborted(request.signal);
						} else {
							throwIfSandboxFilesystemRequestAborted(request.signal);
						}
						if (existingDirectory) continue;
						// oxlint-disable-next-line no-await-in-loop -- Parent directories must be created in path order.
						await runtime.acquisition.strictSshClient.guestMkdir({ path: directoryPath });
						mutationMayHaveApplied = true;
						throwIfSandboxFilesystemMutationAborted(request.signal);
					}
					return { created: true, kind: 'directory-ready', path: resolvedPath };
				}
				case 'sandbox.fs.rename': {
					const parsed = SandboxFsRenameRequestSchema.parse(request.publicRequest);
					const environment = runtime.environments.resolveActiveEnvironment(parsed.environment);
					const sourcePath = resolveSandboxFilesystemPath({
						environmentLogicalCwd: environment.logicalCwd,
						operation: 'mutation',
						requestedPath: parsed.sourcePath,
					});
					const destinationPath = resolveSandboxFilesystemPath({
						environmentLogicalCwd: environment.logicalCwd,
						operation: 'mutation',
						requestedPath: parsed.destinationPath,
					});
					throwIfSandboxFilesystemRequestAborted(request.signal);
					if (!parsed.replace) {
						const destinationExists = await runtime.acquisition.strictSshClient
							.guestStat({ path: destinationPath })
							.then(
								() => true,
								(error: unknown) => {
									if (isMissingGuestPathError(error)) return false;
									throw error;
								},
							);
						if (destinationExists) throw new Error('Sandbox rename destination already exists.');
					}
					throwIfSandboxFilesystemRequestAborted(request.signal);
					await runtime.acquisition.strictSshClient.guestRename({
						fromPath: sourcePath,
						toPath: destinationPath,
					});
					throwIfSandboxFilesystemMutationAborted(request.signal);
					return {
						destinationPath,
						kind: 'renamed',
						sourcePath,
					};
				}
				case 'sandbox.fs.remove': {
					const parsed = SandboxFsRemoveRequestSchema.parse(request.publicRequest);
					const environment = runtime.environments.resolveActiveEnvironment(parsed.environment);
					const resolvedPath = resolveSandboxFilesystemPath({
						environmentLogicalCwd: environment.logicalCwd,
						operation: 'mutation',
						requestedPath: parsed.path,
					});
					throwIfSandboxFilesystemRequestAborted(request.signal);
					const stat = await runtime.acquisition.strictSshClient
						.guestStat({ path: resolvedPath })
						.catch((error: unknown) => {
							if (isMissingGuestPathError(error)) return undefined;
							throw error;
						});
					throwIfSandboxFilesystemRequestAborted(request.signal);
					if (stat === undefined) return { kind: 'removed', path: resolvedPath, removed: false };
					if (parsed.recursive) {
						await removeBoundedSandboxFilesystemTree({
							rootKind: stat.kind === 'directory' ? 'directory' : 'file',
							rootPath: resolvedPath,
							signal: request.signal,
							strictSshClient: runtime.acquisition.strictSshClient,
						});
					} else {
						await runtime.acquisition.strictSshClient.guestRemove({
							kind: stat.kind === 'directory' ? 'directory' : 'file',
							path: resolvedPath,
						});
						throwIfSandboxFilesystemMutationAborted(request.signal);
					}
					return { kind: 'removed', path: resolvedPath, removed: true };
				}
				case 'sandbox.process.start': {
					const parsed = SandboxProcessStartRequestSchema.parse(request.publicRequest);
					const environment = runtime.environments.resolveActiveEnvironment(parsed.environment);
					const started = await processRegistry.startShell({
						command: parsed.command,
						cwd: shellCwd({
							environmentLogicalCwd: environment.logicalCwd,
							requestedCwd: parsed.cwd,
						}),
						...(parsed.environmentVariables === undefined
							? {}
							: { environmentVariables: parsed.environmentVariables }),
						maxRuntimeMs: parsed.maxRuntimeMs,
						retainOutputBytes: parsed.retainOutputBytes,
					});
					indexStartedProcess(runtime, started);
					return started;
				}
				case 'sandbox.process.status':
					return processRegistry.status(
						SandboxProcessHandleRequestSchema.parse(request.publicRequest),
					);
				case 'sandbox.process.wait':
					return await processRegistry.wait(
						SandboxProcessWaitRequestSchema.parse(request.publicRequest),
					);
				case 'sandbox.process.logs':
					return processRegistry.logs(SandboxProcessLogsRequestSchema.parse(request.publicRequest));
				case 'sandbox.process.cancel':
					return processRegistry.cancel(
						SandboxProcessCancelRequestSchema.parse(request.publicRequest),
					);
				case 'sandbox.stream.read':
					return processRegistry.read(SandboxStreamReadRequestSchema.parse(request.publicRequest));
				case 'sandbox.stream.write':
					return await processRegistry.write(
						SandboxStreamWriteRequestSchema.parse(request.publicRequest),
					);
				case 'sandbox.stream.close':
					return processRegistry.closeStream(
						SandboxStreamCloseRequestSchema.parse(request.publicRequest),
					);
				case 'sandbox.terminal.attach': {
					const parsed = SandboxTerminalAttachRequestSchema.parse(request.publicRequest);
					const reservation = runtime.pendingTerminalsByOperationId.get(
						parsed.operation.operationId,
					);
					if (
						reservation === undefined ||
						reservation.terminal.owningGeneration !== parsed.operation.owningGeneration
					) {
						throw new Error('Sandbox terminal reservation is stale or unavailable.');
					}
					clearTimeout(reservation.expiresAt);
					runtime.pendingTerminalsByOperationId.delete(parsed.operation.operationId);
					const environment = runtime.environments.resolveActiveEnvironment(
						reservation.request.environment,
					);
					const started = await processRegistry.startShell({
						command: reservation.request.command,
						cwd: shellCwd({
							environmentLogicalCwd: environment.logicalCwd,
							requestedCwd: reservation.request.cwd,
						}),
						...(reservation.request.environmentVariables === undefined
							? {}
							: { environmentVariables: reservation.request.environmentVariables }),
						maxRuntimeMs: reservation.request.timeoutMs,
						retainOutputBytes: 16 * 1_024 * 1_024,
						terminalSize: parsed.size,
					});
					indexStartedProcess(runtime, started);
					const authority = {
						process: started.process,
						publicOperation: parsed.operation,
						terminal: reservation.terminal,
					} satisfies TerminalProcessAuthority;
					runtime.execProcessesByOperationId.set(parsed.operation.operationId, authority);
					runtime.terminalProcessesByHandleId.set(reservation.terminal.handleId, authority);
					const input = started.streams.find((stream) => stream.channel === 'stdin');
					const output = started.streams.find((stream) => stream.channel === 'stdout');
					if (input === undefined || output === undefined) {
						throw new Error('Sandbox terminal process did not expose input and output streams.');
					}
					return { input, kind: 'attached', output, terminal: reservation.terminal };
				}
				case 'sandbox.terminal.resize': {
					const parsed = SandboxTerminalResizeRequestSchema.parse(request.publicRequest);
					const authority = runtime.terminalProcessesByHandleId.get(parsed.terminal.handleId);
					if (
						authority === undefined ||
						authority.terminal.owningGeneration !== parsed.terminal.owningGeneration
					) {
						throw new Error('Sandbox terminal handle is stale or unavailable.');
					}
					processRegistry.resizeTerminal({ process: authority.process, size: parsed.size });
					return { kind: 'resized', size: parsed.size, terminal: authority.terminal };
				}
			}
			return assertNeverSandboxMethod(request.method);
		} finally {
			endDescendantDispatch();
		}
	};

	const retire = async (): Promise<void> => {
		if (retired) return;
		retired = true;
		const environmentGroups = [...new Set(runtimesByEnvironmentKey.values())];
		try {
			await Promise.all(
				environmentGroups.map(
					async (runtime) => await retireEnvironmentGroup(runtime, 'cancelled'),
				),
			);
		} finally {
			runtimesByActiveUseId.clear();
			runtimesByEnvironmentKey.clear();
			runtimesByOperationKey.clear();
			runtimesByProcessKey.clear();
			runtimesByStreamKey.clear();
			runtimesByTerminalKey.clear();
		}
	};

	return { dispatch, retire };
}
