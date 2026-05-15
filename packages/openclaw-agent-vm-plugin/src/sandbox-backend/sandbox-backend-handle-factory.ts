import {
	ControllerLeaseRequestError,
	createLeaseClient,
	type GondolinLeaseResponse,
	type OpenClawRuntimeStatusReport,
} from '../controller-lease-client.js';
import {
	type CachedScopeEntry,
	type CreateBackendDependencies,
	type FsBridgeLeaseContext,
	type GondolinSandboxBackendHandle,
	isGondolinLeaseResponse,
} from './sandbox-backend-contract.js';
import { buildShellScriptWithArgs } from './sandbox-shell-script.js';

function scopeCacheKey(params: {
	readonly agentWorkspaceDir: string;
	readonly profileId: string;
	readonly scopeKey: string;
	readonly workspaceDir: string;
	readonly zoneId: string;
}): string {
	return [
		params.zoneId,
		params.scopeKey,
		params.profileId,
		params.agentWorkspaceDir,
		params.workspaceDir,
	].join('\0');
}

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function writeSandboxBackendLog(message: string): void {
	process.stderr.write(`[openclaw-agent-vm-plugin] ${message}\n`);
}

function shouldRefreshCachedLease(error: unknown): boolean {
	return error instanceof ControllerLeaseRequestError && error.status === 404;
}

function hasDisposeFunction(
	value: unknown,
): value is { readonly dispose: () => void | Promise<void> } {
	return (
		typeof value === 'object' &&
		value !== null &&
		'dispose' in value &&
		typeof value.dispose === 'function'
	);
}

function renewalIntervalMsForLease(lease: GondolinLeaseResponse): number {
	const fallbackRenewalIntervalMs = 60_000;
	const minimumRenewalIntervalMs = 1_000;
	if (lease.idleTtlMs === undefined) {
		return fallbackRenewalIntervalMs;
	}
	return Math.max(
		minimumRenewalIntervalMs,
		Math.min(fallbackRenewalIntervalMs, Math.floor(lease.idleTtlMs / 3)),
	);
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
	readonly cfg: {
		readonly docker?: {
			readonly env?: Record<string, string>;
		};
	};
	readonly scopeKey: string;
	readonly sessionKey: string;
	readonly workspaceDir: string;
}) => Promise<GondolinSandboxBackendHandle> {
	const scopeCache = new Map<string, CachedScopeEntry>();

	return async (params) => {
		const profileId = options.profileId ?? 'standard';
		const cacheKey = scopeCacheKey({
			agentWorkspaceDir: params.agentWorkspaceDir,
			profileId,
			scopeKey: params.scopeKey,
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
				await leaseClient.keepLeaseAlive(cachedEntry.lease.leaseId);
				return cachedEntry.handle;
			} catch (error) {
				writeSandboxBackendLog(
					`lease keepalive failed for zone '${options.zoneId}' scope '${params.scopeKey}' lease '${cachedEntry.lease.leaseId}': ${formatUnknownError(error)}`,
				);
				if (!shouldRefreshCachedLease(error)) {
					throw error;
				}
				scopeCache.delete(cacheKey);
			}
		}
		// OpenClaw SDK still names the selected sandbox path `workspaceDir`.
		// agent-vm's controller calls the same value `workMountDir` because it
		// backs the Tool VM /work mount.
		const runtimeStatus = options.openClawRuntimeStatusProvider?.();
		if (runtimeStatus && leaseClient.publishOpenClawRuntimeStatus) {
			await leaseClient.publishOpenClawRuntimeStatus(runtimeStatus);
		}
		const leaseResponse = await leaseClient.requestLease({
			agentWorkspaceDir: params.agentWorkspaceDir,
			profileId,
			scopeKey: params.scopeKey,
			workMountDir: params.workspaceDir,
			zoneId: options.zoneId,
		});
		if (!isGondolinLeaseResponse(leaseResponse)) {
			throw new TypeError('Controller lease API returned an unexpected response.');
		}

		const lease = leaseResponse;
		const handle = createSandboxBackendHandle({
			cfg: params.cfg,
			controllerUrl: options.controllerUrl,
			createFsBridgeBuilder: dependencies.createFsBridgeBuilder,
			keepLeaseAlive: async (operation) => {
				try {
					await leaseClient.keepLeaseAlive(lease.leaseId);
				} catch (error) {
					writeSandboxBackendLog(
						`lease command keepalive failed during ${operation} for zone '${options.zoneId}' scope '${params.scopeKey}' lease '${lease.leaseId}': ${formatUnknownError(error)}`,
					);
					if (shouldRefreshCachedLease(error)) {
						const cachedEntryForLease = scopeCache.get(cacheKey);
						if (cachedEntryForLease?.lease.leaseId === lease.leaseId) {
							scopeCache.delete(cacheKey);
						}
					}
					throw error;
				}
			},
			lease,
			runRemoteShellScript: dependencies.runRemoteShellScript,
			buildExecSpec: dependencies.buildExecSpec,
			scopeKey: params.scopeKey,
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
	readonly keepLeaseAlive: (operation: string) => Promise<void>;
	readonly lease: GondolinLeaseResponse;
	readonly runRemoteShellScript: CreateBackendDependencies['runRemoteShellScript'];
	readonly scopeKey: string;
	readonly zoneId: string;
}): GondolinSandboxBackendHandle {
	const renewalIntervalMs = renewalIntervalMsForLease(options.lease);

	function beginLeaseRenewalTimer(operation: string): { readonly dispose: () => void } {
		const interval = setInterval(() => {
			void options.keepLeaseAlive(`${operation} active`).catch((error: unknown) => {
				writeSandboxBackendLog(
					`lease command keepalive failed while ${operation} was active for zone '${options.zoneId}' scope '${options.scopeKey}' lease '${options.lease.leaseId}': ${formatUnknownError(error)}`,
				);
			});
		}, renewalIntervalMs);
		if ('unref' in interval && typeof interval.unref === 'function') {
			interval.unref();
		}
		return {
			dispose: () => clearInterval(interval),
		};
	}

	async function renewLeaseAfterOperation(
		operation: string,
		optionsForRenewal: { readonly hadPrimaryError: boolean },
	): Promise<void> {
		try {
			await options.keepLeaseAlive(operation);
		} catch (error) {
			if (!optionsForRenewal.hadPrimaryError) {
				throw error;
			}
			writeSandboxBackendLog(
				`lease command keepalive failed after ${operation} for zone '${options.zoneId}' scope '${options.scopeKey}' lease '${options.lease.leaseId}': ${formatUnknownError(error)}`,
			);
		}
	}

	async function runWithLeaseRenewal<TValue>(
		operation: string,
		runOperation: () => Promise<TValue>,
	): Promise<TValue> {
		await options.keepLeaseAlive(`${operation} start`);
		const renewalTimer = beginLeaseRenewalTimer(operation);
		try {
			const result = await runOperation();
			renewalTimer.dispose();
			await renewLeaseAfterOperation(`${operation} end`, { hadPrimaryError: false });
			return result;
		} catch (error) {
			renewalTimer.dispose();
			await renewLeaseAfterOperation(`${operation} end`, { hadPrimaryError: true });
			throw error;
		}
	}

	const boundRunRemoteShellScript: FsBridgeLeaseContext['runRemoteShellScript'] = async (
		shellParams,
	) =>
		await runWithLeaseRenewal(
			'fs bridge shell command',
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
			await options.keepLeaseAlive('exec spec build start');
			const execRenewalTimer = beginLeaseRenewalTimer('exec command');
			let execSpec: Awaited<ReturnType<CreateBackendDependencies['buildExecSpec']>>;
			try {
				execSpec = await options.buildExecSpec({
					command: execParams.command,
					env: execParams.env,
					ssh: options.lease.ssh,
					usePty: execParams.usePty,
					workdir: execParams.workdir ?? options.lease.workdir,
				});
			} catch (error) {
				execRenewalTimer.dispose();
				throw error;
			}
			return {
				...execSpec,
				finalizeToken: {
					innerToken: execSpec.finalizeToken,
					leaseRenewalTimer: execRenewalTimer,
				},
			};
		},
		finalizeExec: async (finalizeParams) => {
			const token = finalizeParams.token;
			const leaseRenewalTimer =
				typeof token === 'object' &&
				token !== null &&
				'leaseRenewalTimer' in token &&
				hasDisposeFunction(token.leaseRenewalTimer)
					? token.leaseRenewalTimer
					: undefined;
			const innerToken =
				typeof token === 'object' && token !== null && 'innerToken' in token
					? token.innerToken
					: token;
			let hadPrimaryError = false;
			let primaryError: unknown;
			try {
				if (hasDisposeFunction(innerToken)) {
					await innerToken.dispose();
				}
			} catch (error) {
				hadPrimaryError = true;
				primaryError = error;
			} finally {
				await leaseRenewalTimer?.dispose();
			}
			await renewLeaseAfterOperation('exec finalize', {
				hadPrimaryError,
			});
			if (hadPrimaryError) {
				throw primaryError;
			}
		},
		runShellCommand: async (commandParams) =>
			await runWithLeaseRenewal(
				'shell command',
				async () =>
					await options.runRemoteShellScript({
						script: commandParams.script,
						ssh: options.lease.ssh,
					}),
			),
	} satisfies GondolinSandboxBackendHandle;
}
