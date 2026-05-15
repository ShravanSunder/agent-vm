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
	readonly lease: GondolinLeaseResponse;
	readonly runRemoteShellScript: CreateBackendDependencies['runRemoteShellScript'];
	readonly scopeKey: string;
	readonly zoneId: string;
}): GondolinSandboxBackendHandle {
	const boundRunRemoteShellScript: FsBridgeLeaseContext['runRemoteShellScript'] = async (
		shellParams,
	) =>
		await options.runRemoteShellScript({
			...(shellParams.allowFailure !== undefined ? { allowFailure: shellParams.allowFailure } : {}),
			script: buildShellScriptWithArgs(shellParams.script, shellParams.args),
			...(shellParams.signal !== undefined ? { signal: shellParams.signal } : {}),
			ssh: options.lease.ssh,
			...(shellParams.stdin !== undefined ? { stdin: shellParams.stdin } : {}),
		});

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
		buildExecSpec: async (execParams) =>
			await options.buildExecSpec({
				command: execParams.command,
				env: execParams.env,
				ssh: options.lease.ssh,
				usePty: execParams.usePty,
				workdir: execParams.workdir ?? options.lease.workdir,
			}),
		finalizeExec: async (finalizeParams) => {
			if (
				finalizeParams.token &&
				typeof finalizeParams.token === 'object' &&
				'dispose' in finalizeParams.token
			) {
				await (finalizeParams.token as { dispose: () => Promise<void> }).dispose();
			}
		},
		runShellCommand: async (commandParams) =>
			await options.runRemoteShellScript({
				script: commandParams.script,
				ssh: options.lease.ssh,
			}),
	} satisfies GondolinSandboxBackendHandle;
}
