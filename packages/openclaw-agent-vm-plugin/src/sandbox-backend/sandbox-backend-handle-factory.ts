import { createHash } from 'node:crypto';
import path from 'node:path/posix';

import {
	type AgentVmHealthEvent,
	createToolVmActiveUseHandle,
	type EndToolVmActiveUseRequest,
	type HeartbeatToolVmActiveUseResponse,
	type StartToolVmActiveUseRequest,
	type StartToolVmActiveUseResponse,
	type ToolVmActiveUseCorrelation,
	type ToolVmActiveUseHandle,
	type ToolVmActiveUseOutcome,
	type ToolVmSshFailureKind,
	isToolVmSshLease,
} from '@agent-vm/gateway-interface';

import {
	ControllerLeaseRequestError,
	type LeaseClient,
	type OpenClawRuntimeStatusReport,
} from '../lease-client-contract.js';
import {
	findOpenClawGondolinSandboxMismatch,
	resolveOpenClawAgentIdFromSessionKey,
	type OpenClawGondolinSandboxSnapshot,
} from '../openclaw-gondolin-contract.js';
import { resolveOpenClawAgentWorkspaceSource } from './openclaw-agent-workspace-source.js';
import { assertOpenClawToolVmPathIntent } from './openclaw-tool-vm-path-mapping.js';
import {
	type CachedAgentLeaseEntry,
	type CreateBackendDependencies,
	type OpenClawFsBridgeLeaseContext,
	type OpenClawSandboxBackendHandle,
} from './sandbox-backend-contract.js';
import { buildShellScriptWithArgs } from './sandbox-shell-script.js';
import {
	runToolVmSshOperationWithGuard,
	ToolVmSshOperationStaleError,
} from './tool-vm-ssh-operation-guard.js';

function agentLeaseCacheKey(params: { readonly agentId: string; readonly zoneId: string }): string {
	return [params.zoneId, params.agentId].join('\0');
}

type CachedAgentLeaseCompatibility = Pick<
	CachedAgentLeaseEntry,
	'agentWorkspaceDir' | 'leaseWorkMountDir' | 'profileId'
>;

function findCachedLeaseCompatibilityMismatch(params: {
	readonly cachedEntry: CachedAgentLeaseCompatibility;
	readonly requestedEntry: CachedAgentLeaseCompatibility;
}): string | undefined {
	if (params.cachedEntry.agentWorkspaceDir !== params.requestedEntry.agentWorkspaceDir) {
		return 'agentWorkspaceDir';
	}
	if (params.cachedEntry.leaseWorkMountDir !== params.requestedEntry.leaseWorkMountDir) {
		return 'leaseWorkMountDir';
	}
	if (params.cachedEntry.profileId !== params.requestedEntry.profileId) {
		return 'profileId';
	}
	return undefined;
}

function assertCachedLeaseCompatible(params: {
	readonly agentId: string;
	readonly cachedEntry: CachedAgentLeaseCompatibility;
	readonly requestedEntry: CachedAgentLeaseCompatibility;
	readonly zoneId: string;
}): void {
	const mismatch = findCachedLeaseCompatibilityMismatch(params);
	if (mismatch === undefined) {
		return;
	}
	throw new Error(
		`Cannot reuse cached Tool VM lease for zone '${params.zoneId}' agent '${params.agentId}': ${mismatch} changed.`,
	);
}

function formatControllerLeaseRequestError(error: ControllerLeaseRequestError): string {
	const responseBody =
		error.responseBody === undefined ? error.bodyText : JSON.stringify(error.responseBody);
	return `${error.message}; response=${responseBody}`;
}

function formatUnknownError(error: unknown): string {
	if (error instanceof ControllerLeaseRequestError) {
		return formatControllerLeaseRequestError(error);
	}
	return error instanceof Error ? error.message : String(error);
}

function writeSandboxBackendLog(message: string): void {
	process.stderr.write(`[openclaw-agent-vm-plugin] ${message}\n`);
}

function shouldRefreshCachedLease(error: unknown): boolean {
	return isRefreshableLeaseError(error);
}

function isRefreshableLeaseError(error: unknown): boolean {
	return (
		error instanceof ControllerLeaseRequestError && (error.status === 404 || error.status === 410)
	);
}

function isCleanupNotFound(error: unknown): boolean {
	return error instanceof ControllerLeaseRequestError && error.status === 404;
}

interface DisposableFinalizeToken {
	dispose(): Promise<void>;
}

interface ActiveUseFinalizeToken {
	readonly activeUseHandle: ToolVmActiveUseHandle;
	readonly innerToken?: unknown;
}

function isDisposableFinalizeToken(value: unknown): value is DisposableFinalizeToken {
	return (
		typeof value === 'object' &&
		value !== null &&
		'dispose' in value &&
		typeof Reflect.get(value, 'dispose') === 'function'
	);
}

function isActiveUseFinalizeToken(value: unknown): value is ActiveUseFinalizeToken {
	return (
		typeof value === 'object' &&
		value !== null &&
		'activeUseHandle' in value &&
		typeof Reflect.get(value, 'activeUseHandle') === 'object'
	);
}

function activeUseOutcomeForFinalizeParams(finalizeParams: {
	readonly status: 'completed' | 'failed';
	readonly timedOut: boolean;
}): ToolVmActiveUseOutcome {
	return finalizeParams.timedOut
		? 'timed-out'
		: finalizeParams.status === 'completed'
			? 'completed'
			: 'failed';
}

async function publishFinalizeToolVmSshHealthEvent(options: {
	readonly agentId: string;
	readonly correlation?: ToolVmActiveUseCorrelation | undefined;
	readonly leaseId: string;
	readonly publishHealthEvent: (event: AgentVmHealthEvent) => Promise<void>;
	readonly timedOut: boolean;
	readonly zoneId: string;
}): Promise<void> {
	const event = {
		agentId: options.agentId,
		...(options.correlation?.requestId === undefined
			? {}
			: { requestId: options.correlation.requestId }),
		...(options.correlation?.runId === undefined ? {} : { runId: options.correlation.runId }),
		...(options.correlation?.sessionKeyDigest === undefined
			? {}
			: { sessionKeyDigest: options.correlation.sessionKeyDigest }),
		...(options.correlation?.toolCallId === undefined
			? {}
			: { toolCallId: options.correlation.toolCallId }),
		...(options.correlation?.traceId === undefined ? {} : { traceId: options.correlation.traceId }),
		elapsedMs: 0,
		...(options.timedOut ? { errorCode: 'ssh-command-timed-out' } : {}),
		kind: 'tool-vm-ssh',
		leaseId: options.leaseId,
		observedAtMs: Date.now(),
		operation: 'finalize',
		result: options.timedOut ? 'failed' : 'ok',
		zoneId: options.zoneId,
	} satisfies AgentVmHealthEvent;
	try {
		await options.publishHealthEvent(event);
	} catch (error) {
		writeSandboxBackendLog(
			`tool-vm-ssh finalize health publish failed for zone '${options.zoneId}' lease '${options.leaseId}': ${formatUnknownError(error)}`,
		);
	}
}

function mergedAbortSignal(
	firstSignal: AbortSignal | undefined,
	secondSignal: AbortSignal,
): AbortSignal {
	if (firstSignal === undefined) {
		return secondSignal;
	}
	return AbortSignal.any([firstSignal, secondSignal]);
}

function sessionKeyCorrelation(sessionKey: string): ToolVmActiveUseCorrelation {
	return {
		sessionKeyDigest: createHash('sha256').update(sessionKey, 'utf8').digest('hex'),
	};
}

function mergeToolVmCorrelation(
	sessionCorrelation: ToolVmActiveUseCorrelation,
	correlation: ToolVmActiveUseCorrelation | undefined,
): ToolVmActiveUseCorrelation {
	if (correlation === undefined) {
		return sessionCorrelation;
	}
	return {
		...sessionCorrelation,
		...correlation,
	};
}

function mergedAbortSignals(
	signals: readonly (AbortSignal | undefined)[],
): AbortSignal | undefined {
	const presentSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
	if (presentSignals.length === 0) {
		return undefined;
	}
	if (presentSignals.length === 1) {
		return presentSignals[0];
	}
	return AbortSignal.any(presentSignals);
}

function resolveLeaseRequestAgentId(sessionKey: string): string {
	return resolveOpenClawAgentIdFromSessionKey(sessionKey);
}

function defaultOpenClawStateDir(): string | undefined {
	const explicitStateDir = process.env.OPENCLAW_STATE_DIR?.trim();
	if (explicitStateDir) {
		return path.resolve(explicitStateDir);
	}
	const homeDirectory = process.env.HOME?.trim();
	return homeDirectory ? path.join(homeDirectory, '.openclaw', 'state') : undefined;
}

function defaultOpenClawWorkspaceDir(): string | undefined {
	const homeDirectory = process.env.HOME?.trim();
	if (!homeDirectory) {
		return undefined;
	}
	const profile = process.env.OPENCLAW_PROFILE?.trim().toLowerCase();
	return profile && profile !== 'default'
		? path.join(homeDirectory, '.openclaw', `workspace-${profile}`)
		: path.join(homeDirectory, '.openclaw', 'workspace');
}

function assertPluginLeaseContract(params: {
	readonly cfg: OpenClawGondolinSandboxSnapshot;
}): void {
	const mismatch = findOpenClawGondolinSandboxMismatch(params.cfg);
	if (mismatch) {
		throw new Error(
			`OpenClaw Gondolin sandbox requires ${mismatch.key}=${mismatch.expectedValue}; received ${String(params.cfg[mismatch.key])}.`,
		);
	}
}

export function createGondolinSandboxBackendFactory(
	options: {
		readonly controllerUrl: string;
		readonly openClawDefaultWorkspaceDirProvider?: () => string | undefined;
		readonly openClawRuntimeStatusProvider?: () => OpenClawRuntimeStatusReport | undefined;
		readonly openClawRuntimeConfigProvider?: () => Record<string, unknown> | undefined;
		readonly openClawStateDirProvider?: () => string | undefined;
		readonly profileId?: string;
		readonly zoneId: string;
	},
	dependencies: CreateBackendDependencies,
): (params: {
	readonly agentWorkspaceDir: string;
	readonly cfg: OpenClawGondolinSandboxSnapshot & {
		readonly docker?: {
			readonly env?: Record<string, string>;
		};
	};
	// OpenClaw SDK boundary input only. Agent-vm leases are keyed by agentId,
	// so this value is intentionally not read or forwarded to the controller.
	readonly scopeKey: string;
	readonly sessionKey: string;
	readonly workspaceDir: string;
}) => Promise<OpenClawSandboxBackendHandle> {
	const agentLeaseCache = new Map<string, CachedAgentLeaseEntry>();
	const inFlightLeaseRequests = new Map<string, Promise<CachedAgentLeaseEntry>>();

	return async (params) => {
		const profileId = options.profileId ?? 'standard';
		const agentId = resolveLeaseRequestAgentId(params.sessionKey);
		assertPluginLeaseContract({
			cfg: params.cfg,
		});
		const defaultWorkspaceDir =
			options.openClawDefaultWorkspaceDirProvider?.() ?? defaultOpenClawWorkspaceDir();
		const equivalentAgentWorkspaceDirs =
			defaultWorkspaceDir === undefined ? [] : [defaultWorkspaceDir];
		const workspaceSource = resolveOpenClawAgentWorkspaceSource({
			agentId,
			defaultWorkspaceDir,
			openClawConfig: options.openClawRuntimeConfigProvider?.(),
			paramsAgentWorkspaceDir: params.agentWorkspaceDir,
			stateDir: options.openClawStateDirProvider?.() ?? defaultOpenClawStateDir(),
		});
		const pathIntent = assertOpenClawToolVmPathIntent({
			agentWorkspaceDir: workspaceSource.sourceDir,
			equivalentAgentWorkspaceDirs,
			inputPath: params.workspaceDir,
		});
		const cacheKey = agentLeaseCacheKey({
			agentId,
			zoneId: options.zoneId,
		});
		const requestedCacheEntry = {
			agentWorkspaceDir: workspaceSource.sourceDir,
			leaseWorkMountDir: pathIntent.leaseWorkMountDir,
			profileId,
		} satisfies CachedAgentLeaseCompatibility;
		const leaseClient = dependencies.createLeaseClient({
			controllerUrl: options.controllerUrl,
		});
		const publishHealthEvent = async (event: AgentVmHealthEvent): Promise<void> => {
			if (dependencies.publishHealthEvent === undefined) {
				throw new Error('OpenClaw Gondolin sandbox requires a gateway-control health publisher.');
			}
			await dependencies.publishHealthEvent(event);
		};
		const markLeaseStale = async (
			lease: CachedAgentLeaseEntry['lease'],
			reason: ToolVmSshFailureKind,
			error: unknown,
		): Promise<void> => {
			agentLeaseCache.delete(cacheKey);
			writeSandboxBackendLog(
				`lease marked stale for zone '${options.zoneId}' agent '${agentId}' lease '${lease.leaseId}' reason '${reason}': ${formatUnknownError(error)}`,
			);
			await leaseClient
				.releaseLease(lease.leaseId, { force: true })
				.catch((releaseError: unknown) => {
					writeSandboxBackendLog(
						`best-effort stale lease release failed for zone '${options.zoneId}' agent '${agentId}' lease '${lease.leaseId}': ${formatUnknownError(releaseError)}`,
					);
				});
		};
		const cachedEntry = agentLeaseCache.get(cacheKey);
		let lease: CachedAgentLeaseEntry['lease'] | undefined;
		if (cachedEntry) {
			assertCachedLeaseCompatible({
				agentId,
				cachedEntry,
				requestedEntry: requestedCacheEntry,
				zoneId: options.zoneId,
			});
			try {
				const renewedLease = await leaseClient.renewLease(cachedEntry.lease.leaseId);
				await runToolVmSshOperationWithGuard({
					healthEvent: {
						agentId,
						correlation: sessionKeyCorrelation(params.sessionKey),
						leaseId: renewedLease.leaseId,
						operation: 'probe',
						publish: publishHealthEvent,
						zoneId: options.zoneId,
					},
					operation: async (signal) =>
						await dependencies.runRemoteShellScript({
							allowFailure: false,
							script: 'true',
							signal,
							ssh: renewedLease.ssh,
						}),
					operationName: 'cached-ssh-probe',
					report: () => {},
					timeoutMs: 30_000,
				});
				lease = renewedLease;
				agentLeaseCache.set(cacheKey, { ...requestedCacheEntry, lease });
			} catch (error) {
				writeSandboxBackendLog(
					`lease renew failed for zone '${options.zoneId}' agent '${agentId}' lease '${cachedEntry.lease.leaseId}': ${formatUnknownError(error)}`,
				);
				if (error instanceof ToolVmSshOperationStaleError) {
					await markLeaseStale(cachedEntry.lease, error.reason, error);
				} else if (shouldRefreshCachedLease(error)) {
					agentLeaseCache.delete(cacheKey);
				} else {
					throw error;
				}
			}
		}
		if (lease === undefined) {
			const inFlightLeaseRequest = inFlightLeaseRequests.get(cacheKey);
			if (inFlightLeaseRequest !== undefined) {
				const inFlightEntry = await inFlightLeaseRequest;
				assertCachedLeaseCompatible({
					agentId,
					cachedEntry: inFlightEntry,
					requestedEntry: requestedCacheEntry,
					zoneId: options.zoneId,
				});
				lease = inFlightEntry.lease;
			} else {
				// OpenClaw SDK still names the selected sandbox path `workspaceDir`.
				// agent-vm's controller calls the selected host source `workMountDir`.
				const leaseRequestPromise = (async (): Promise<CachedAgentLeaseEntry> => {
					const runtimeStatus = options.openClawRuntimeStatusProvider?.();
					if (runtimeStatus && dependencies.publishOpenClawRuntimeStatus) {
						await dependencies.publishOpenClawRuntimeStatus(runtimeStatus);
					}
					const leaseResponse = await leaseClient.requestLease({
						agentId,
						agentWorkspaceDir: workspaceSource.sourceDir,
						profileId,
						sessionKey: params.sessionKey,
						workMountDir: pathIntent.leaseWorkMountDir,
						zoneId: options.zoneId,
					});
					if (!isToolVmSshLease(leaseResponse)) {
						throw new TypeError('Controller lease API returned an unexpected response.');
					}
					return {
						...requestedCacheEntry,
						lease: leaseResponse,
					};
				})();
				inFlightLeaseRequests.set(cacheKey, leaseRequestPromise);
				try {
					const leaseEntry = await leaseRequestPromise;
					agentLeaseCache.set(cacheKey, leaseEntry);
					lease = leaseEntry.lease;
				} finally {
					if (inFlightLeaseRequests.get(cacheKey) === leaseRequestPromise) {
						inFlightLeaseRequests.delete(cacheKey);
					}
				}
			}
		}
		const handle = createSandboxBackendHandle({
			cfg: params.cfg,
			controllerUrl: options.controllerUrl,
			createFsBridgeBuilder: dependencies.createFsBridgeBuilder,
			effectiveGuestCwd: pathIntent.effectiveGuestCwd,
			lease,
			leaseClient,
			markCachedLeaseStale: async (reason, error) => {
				await markLeaseStale(lease, reason, error);
			},
			publishHealthEvent,
			runRemoteShellScript: dependencies.runRemoteShellScript,
			buildExecSpec: dependencies.buildExecSpec,
			sessionKey: params.sessionKey,
			zoneId: options.zoneId,
		});
		return handle;
	};
}

function createSandboxBackendHandle(options: {
	readonly buildExecSpec: CreateBackendDependencies['buildExecSpec'];
	readonly cfg: {
		readonly docker?: {
			readonly env?: Record<string, string>;
		};
	};
	readonly controllerUrl: string;
	readonly createFsBridgeBuilder?: CreateBackendDependencies['createFsBridgeBuilder'];
	readonly effectiveGuestCwd: string;
	readonly lease: CachedAgentLeaseEntry['lease'];
	readonly leaseClient: LeaseClient;
	readonly markCachedLeaseStale: (reason: ToolVmSshFailureKind, error: unknown) => Promise<void>;
	readonly publishHealthEvent: (event: AgentVmHealthEvent) => Promise<void>;
	readonly runRemoteShellScript: CreateBackendDependencies['runRemoteShellScript'];
	readonly sessionKey: string;
	readonly zoneId: string;
}): OpenClawSandboxBackendHandle {
	const defaultCorrelation = sessionKeyCorrelation(options.sessionKey);
	const createActiveUseHandle = async (
		correlation?: ToolVmActiveUseCorrelation,
	): Promise<ToolVmActiveUseHandle> => {
		try {
			return await createToolVmActiveUseHandle({
				correlation: mergeToolVmCorrelation(defaultCorrelation, correlation),
				endActiveUse: async (useId: string, request: EndToolVmActiveUseRequest): Promise<void> => {
					await options.leaseClient.endActiveUse(options.lease.leaseId, useId, request);
				},
				heartbeatActiveUse: async (useId, request): Promise<HeartbeatToolVmActiveUseResponse> =>
					await options.leaseClient.heartbeatActiveUse(options.lease.leaseId, useId, request),
				isEndErrorTolerable: isCleanupNotFound,
				isHeartbeatErrorRefreshable: isRefreshableLeaseError,
				logEndFailure: (error: unknown): void => {
					writeSandboxBackendLog(
						`active-use cleanup ignored for zone '${options.zoneId}' lease '${options.lease.leaseId}': ${formatUnknownError(error)}`,
					);
				},
				logHeartbeatFailure: (error: unknown): void => {
					writeSandboxBackendLog(
						`active-use heartbeat failed for zone '${options.zoneId}' lease '${options.lease.leaseId}': ${formatUnknownError(error)}`,
					);
				},
				onRefreshableHeartbeatFailure: async (error): Promise<void> => {
					await options.markCachedLeaseStale('active-use-refreshable-failure', error);
				},
				startActiveUse: async (
					request: StartToolVmActiveUseRequest,
				): Promise<StartToolVmActiveUseResponse> =>
					await options.leaseClient.startActiveUse(options.lease.leaseId, request),
			});
		} catch (error) {
			if (isRefreshableLeaseError(error)) {
				await options.markCachedLeaseStale('active-use-refreshable-failure', error);
			}
			throw error;
		}
	};

	const runWithActiveUse = async <TResult>(
		correlation: ToolVmActiveUseCorrelation | undefined,
		fn: (activeUseHandle: ToolVmActiveUseHandle) => Promise<TResult>,
	): Promise<TResult> => {
		const operationCorrelation = mergeToolVmCorrelation(defaultCorrelation, correlation);
		const activeUseHandle = await createActiveUseHandle(operationCorrelation);
		try {
			const result = await fn(activeUseHandle);
			await activeUseHandle.dispose('completed');
			return result;
		} catch (error) {
			await activeUseHandle
				.dispose(
					error instanceof ToolVmSshOperationStaleError && error.reason === 'ssh-command-timed-out'
						? 'timed-out'
						: 'failed',
				)
				.catch((cleanupError: unknown) => {
					writeSandboxBackendLog(
						`failed to end active use after operation failure for zone '${options.zoneId}' lease '${options.lease.leaseId}': ${formatUnknownError(cleanupError)}`,
					);
				});
			if (error instanceof ToolVmSshOperationStaleError) {
				await options.markCachedLeaseStale(error.reason, error);
			}
			throw error;
		}
	};

	const boundRunRemoteShellScript: OpenClawFsBridgeLeaseContext['runRemoteShellScript'] = async (
		shellParams,
	) =>
		await runWithActiveUse(
			undefined,
			async (activeUseHandle) =>
				await runToolVmSshOperationWithGuard({
					healthEvent: {
						agentId: options.lease.agentId,
						correlation: defaultCorrelation,
						leaseId: options.lease.leaseId,
						operation: 'file-bridge',
						publish: options.publishHealthEvent,
						zoneId: options.zoneId,
					},
					operation: async (signal) => {
						const operationSignal = mergedAbortSignals([
							shellParams.signal,
							activeUseHandle.signal,
							signal,
						]);
						return await options.runRemoteShellScript({
							...(shellParams.allowFailure !== undefined
								? { allowFailure: shellParams.allowFailure }
								: {}),
							script: buildShellScriptWithArgs(shellParams.script, shellParams.args),
							...(operationSignal === undefined ? {} : { signal: operationSignal }),
							ssh: options.lease.ssh,
							...(shellParams.stdin !== undefined ? { stdin: shellParams.stdin } : {}),
						});
					},
					operationName: 'fs-bridge',
					report: (report) => {
						activeUseHandle.report(report);
					},
					timeoutMs: 30_000,
				}),
		);

	const disposeInnerFinalizeToken = async (token: unknown): Promise<void> => {
		if (isDisposableFinalizeToken(token)) {
			await token.dispose();
		}
	};

	const endActiveUseFinalizeToken = async (
		token: ActiveUseFinalizeToken,
		outcome: ToolVmActiveUseOutcome,
	): Promise<void> => {
		let innerError: unknown;
		try {
			await disposeInnerFinalizeToken(token.innerToken);
		} catch (error) {
			innerError = error;
		}
		let activeUseError: unknown;
		try {
			await token.activeUseHandle.dispose(outcome);
		} catch (error) {
			activeUseError = error;
		}
		if (innerError) {
			throw innerError;
		}
		if (activeUseError) {
			throw activeUseError;
		}
	};

	const createFsBridge = options.createFsBridgeBuilder?.({
		remoteAgentWorkspaceDir: options.lease.workdir,
		remoteWorkspaceDir: options.effectiveGuestCwd,
		runRemoteShellScript: boundRunRemoteShellScript,
	});

	return {
		...(createFsBridge ? { createFsBridge } : {}),
		...(options.cfg.docker?.env ? { env: options.cfg.docker.env } : {}),
		configLabel: `${options.controllerUrl} (${options.zoneId})`,
		configLabelKind: 'VM',
		id: 'gondolin',
		runtimeId: options.lease.leaseId,
		runtimeLabel: options.lease.leaseId,
		workdir: options.effectiveGuestCwd,
		buildExecSpec: async (execParams) => {
			const activeUseHandle = await createActiveUseHandle();
			try {
				const execSpec = await options.buildExecSpec({
					command: execParams.command,
					env: execParams.env,
					ssh: options.lease.ssh,
					usePty: execParams.usePty,
					workdir: execParams.workdir ?? options.effectiveGuestCwd,
				});
				return {
					...execSpec,
					finalizeToken: {
						activeUseHandle,
						...(execSpec.finalizeToken !== undefined ? { innerToken: execSpec.finalizeToken } : {}),
					} satisfies ActiveUseFinalizeToken,
				};
			} catch (error) {
				await activeUseHandle.dispose('failed').catch((cleanupError: unknown) => {
					writeSandboxBackendLog(
						`failed to end active use after buildExecSpec failure for zone '${options.zoneId}' lease '${options.lease.leaseId}': ${formatUnknownError(cleanupError)}`,
					);
				});
				throw error;
			}
		},
		finalizeExec: async (finalizeParams) => {
			if (isActiveUseFinalizeToken(finalizeParams.token)) {
				if (finalizeParams.timedOut) {
					finalizeParams.token.activeUseHandle.report({
						observedAtMs: Date.now(),
						phase: 'failed',
						ssh: {
							failure: {
								kind: 'ssh-command-timed-out',
								message: 'exec command timed out.',
							},
						},
					});
				}
				await endActiveUseFinalizeToken(
					finalizeParams.token,
					activeUseOutcomeForFinalizeParams(finalizeParams),
				);
				void publishFinalizeToolVmSshHealthEvent({
					agentId: options.lease.agentId,
					correlation: defaultCorrelation,
					leaseId: options.lease.leaseId,
					publishHealthEvent: options.publishHealthEvent,
					timedOut: finalizeParams.timedOut,
					zoneId: options.zoneId,
				});
				if (finalizeParams.timedOut) {
					await options.markCachedLeaseStale('ssh-command-timed-out', undefined);
				}
				return;
			}
			await disposeInnerFinalizeToken(finalizeParams.token);
		},
		runShellCommand: async (commandParams) =>
			await runWithActiveUse(
				undefined,
				async (activeUseHandle) =>
					await runToolVmSshOperationWithGuard({
						healthEvent: {
							agentId: options.lease.agentId,
							correlation: defaultCorrelation,
							leaseId: options.lease.leaseId,
							operation: 'command',
							publish: options.publishHealthEvent,
							zoneId: options.zoneId,
						},
						operation: async (signal) =>
							await options.runRemoteShellScript({
								script: commandParams.script,
								signal: mergedAbortSignal(activeUseHandle.signal, signal),
								ssh: options.lease.ssh,
							}),
						operationName: 'runShellCommand',
						report: (report) => {
							activeUseHandle.report(report);
						},
						timeoutMs: 30_000,
					}),
			),
	} satisfies OpenClawSandboxBackendHandle;
}
