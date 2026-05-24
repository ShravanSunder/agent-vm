import {
	createToolVmActiveUseHandle,
	type ToolVmActiveUseHandle,
	type ToolVmActiveUseOutcome,
	type ToolVmActiveUseCorrelation,
	type StartToolVmActiveUseRequest,
	type StartToolVmActiveUseResponse,
	type HeartbeatToolVmActiveUseResponse,
	type EndToolVmActiveUseRequest,
	isToolVmSshLease,
} from '@agent-vm/gateway-interface';

import {
	ControllerLeaseRequestError,
	createLeaseClient,
	type LeaseClient,
	type OpenClawRuntimeStatusReport,
} from '../controller-lease-client.js';
import {
	findOpenClawGondolinSandboxMismatch,
	resolveOpenClawAgentIdFromSessionKey,
	snapshotOpenClawGondolinSandboxConfig,
	type OpenClawGondolinSandboxSnapshot,
} from '../openclaw-gondolin-contract.js';
import {
	type CachedScopeEntry,
	type CreateBackendDependencies,
	type OpenClawFsBridgeLeaseContext,
	type OpenClawSandboxBackendHandle,
} from './sandbox-backend-contract.js';
import { buildShellScriptWithArgs } from './sandbox-shell-script.js';

function agentLeaseCacheKey(params: {
	readonly agentId: string;
	readonly agentWorkspaceDir: string;
	readonly profileId: string;
	readonly workspaceDir: string;
	readonly zoneId: string;
}): string {
	return [
		params.zoneId,
		params.agentId,
		params.profileId,
		params.agentWorkspaceDir,
		params.workspaceDir,
	].join('\0');
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
	return error instanceof ControllerLeaseRequestError && error.status === 404;
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

function resolveLeaseRequestAgentId(sessionKey: string): string {
	return resolveOpenClawAgentIdFromSessionKey(sessionKey);
}

function assertPluginLeaseContract(params: {
	readonly agentId: string;
	readonly cfg: OpenClawGondolinSandboxSnapshot;
	readonly scopeKey: string;
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
		readonly openClawRuntimeStatusProvider?: () => OpenClawRuntimeStatusReport | undefined;
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
	readonly scopeKey: string;
	readonly sessionKey: string;
	readonly workspaceDir: string;
}) => Promise<OpenClawSandboxBackendHandle> {
	const scopeCache = new Map<string, CachedScopeEntry>();

	return async (params) => {
		const profileId = options.profileId ?? 'standard';
		const agentId = resolveLeaseRequestAgentId(params.sessionKey);
		assertPluginLeaseContract({
			agentId,
			cfg: params.cfg,
			scopeKey: params.scopeKey,
		});
		const cacheKey = agentLeaseCacheKey({
			agentId,
			agentWorkspaceDir: params.agentWorkspaceDir,
			profileId,
			workspaceDir: params.workspaceDir,
			zoneId: options.zoneId,
		});
		const leaseClient =
			dependencies.createLeaseClient?.({
				controllerUrl: options.controllerUrl,
			}) ?? createLeaseClient({ controllerUrl: options.controllerUrl });
		const cachedEntry = scopeCache.get(cacheKey);
		if (cachedEntry) {
			try {
				await leaseClient.renewLease(cachedEntry.lease.leaseId);
				return cachedEntry.handle;
			} catch (error) {
				writeSandboxBackendLog(
					`lease renew failed for zone '${options.zoneId}' scope '${params.scopeKey}' lease '${cachedEntry.lease.leaseId}': ${formatUnknownError(error)}`,
				);
				if (!shouldRefreshCachedLease(error)) {
					throw error;
				}
				scopeCache.delete(cacheKey);
			}
		}
		// OpenClaw SDK still names the selected sandbox path `workspaceDir`.
		// agent-vm's controller calls the same value `workMountDir` because it
		// selects the host path exposed at the lease response `workdir`.
		const runtimeStatus = options.openClawRuntimeStatusProvider?.();
		if (runtimeStatus && leaseClient.publishOpenClawRuntimeStatus) {
			await leaseClient.publishOpenClawRuntimeStatus(runtimeStatus);
		}
		const leaseResponse = await leaseClient.requestLease({
			agentId,
			agentWorkspaceDir: params.agentWorkspaceDir,
			profileId,
			sandbox: snapshotOpenClawGondolinSandboxConfig(params.cfg),
			scopeKey: params.scopeKey,
			sessionKey: params.sessionKey,
			workMountDir: params.workspaceDir,
			zoneId: options.zoneId,
		});
		if (!isToolVmSshLease(leaseResponse)) {
			throw new TypeError('Controller lease API returned an unexpected response.');
		}

		const lease = leaseResponse;
		const handle = createSandboxBackendHandle({
			cfg: params.cfg,
			controllerUrl: options.controllerUrl,
			createFsBridgeBuilder: dependencies.createFsBridgeBuilder,
			lease,
			leaseClient,
			runRemoteShellScript: dependencies.runRemoteShellScript,
			buildExecSpec: dependencies.buildExecSpec,
			scopeKey: params.scopeKey,
			sessionKey: params.sessionKey,
			zoneId: options.zoneId,
		});
		scopeCache.set(cacheKey, { handle, lease });
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
	readonly lease: CachedScopeEntry['lease'];
	readonly leaseClient: LeaseClient;
	readonly runRemoteShellScript: CreateBackendDependencies['runRemoteShellScript'];
	readonly scopeKey: string;
	readonly sessionKey: string;
	readonly zoneId: string;
}): OpenClawSandboxBackendHandle {
	const createActiveUseHandle = async (
		correlation: ToolVmActiveUseCorrelation,
	): Promise<ToolVmActiveUseHandle> =>
		await createToolVmActiveUseHandle({
			correlation,
			endActiveUse: async (useId: string, request: EndToolVmActiveUseRequest): Promise<void> => {
				await options.leaseClient.endActiveUse(options.lease.leaseId, useId, request);
			},
			heartbeatActiveUse: async (useId: string): Promise<HeartbeatToolVmActiveUseResponse> =>
				await options.leaseClient.heartbeatActiveUse(options.lease.leaseId, useId),
			isEndErrorTolerable: isCleanupNotFound,
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
			startActiveUse: async (
				request: StartToolVmActiveUseRequest,
			): Promise<StartToolVmActiveUseResponse> =>
				await options.leaseClient.startActiveUse(options.lease.leaseId, request),
		});

	const runWithActiveUse = async <TResult>(
		correlation: ToolVmActiveUseCorrelation,
		fn: () => Promise<TResult>,
	): Promise<TResult> => {
		const activeUseHandle = await createActiveUseHandle(correlation);
		try {
			const result = await fn();
			await activeUseHandle.dispose('completed');
			return result;
		} catch (error) {
			await activeUseHandle.dispose('failed').catch((cleanupError: unknown) => {
				writeSandboxBackendLog(
					`failed to end active use after operation failure for zone '${options.zoneId}' lease '${options.lease.leaseId}': ${formatUnknownError(cleanupError)}`,
				);
			});
			throw error;
		}
	};

	const boundRunRemoteShellScript: OpenClawFsBridgeLeaseContext['runRemoteShellScript'] = async (
		shellParams,
	) =>
		await runWithActiveUse(
			{
				sessionKey: options.sessionKey,
				toolName: 'fs-bridge',
			},
			async () =>
				await options.runRemoteShellScript({
					...(shellParams.allowFailure !== undefined
						? { allowFailure: shellParams.allowFailure }
						: {}),
					script: buildShellScriptWithArgs(shellParams.script, shellParams.args),
					...(shellParams.signal !== undefined ? { signal: shellParams.signal } : {}),
					ssh: options.lease.ssh,
					...(shellParams.stdin !== undefined ? { stdin: shellParams.stdin } : {}),
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
		remoteWorkspaceDir: options.lease.workdir,
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
		workdir: options.lease.workdir,
		buildExecSpec: async (execParams) => {
			const activeUseHandle = await createActiveUseHandle({
				sessionKey: options.sessionKey,
				toolName: 'shell',
			});
			try {
				const execSpec = await options.buildExecSpec({
					command: execParams.command,
					env: execParams.env,
					ssh: options.lease.ssh,
					usePty: execParams.usePty,
					workdir: execParams.workdir ?? options.lease.workdir,
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
				await endActiveUseFinalizeToken(
					finalizeParams.token,
					activeUseOutcomeForFinalizeParams(finalizeParams),
				);
				return;
			}
			await disposeInnerFinalizeToken(finalizeParams.token);
		},
		runShellCommand: async (commandParams) =>
			await runWithActiveUse(
				{
					sessionKey: options.sessionKey,
					toolName: 'runShellCommand',
				},
				async () =>
					await options.runRemoteShellScript({
						script: commandParams.script,
						ssh: options.lease.ssh,
					}),
			),
	} satisfies OpenClawSandboxBackendHandle;
}
