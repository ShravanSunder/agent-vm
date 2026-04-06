import { createLeaseClient, type GondolinLeaseResponse, type LeaseClient } from './lease-client.js';

function isGondolinLeaseResponse(value: unknown): value is GondolinLeaseResponse {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { leaseId?: unknown }).leaseId === 'string' &&
		typeof (value as { tcpSlot?: unknown }).tcpSlot === 'number' &&
		typeof (value as { workdir?: unknown }).workdir === 'string' &&
		typeof (value as { ssh?: unknown }).ssh === 'object' &&
		(value as { ssh?: unknown }).ssh !== null
	);
}

interface CreateBackendDependencies {
	readonly buildExecSpec: (params: {
		readonly command: string;
		readonly env: Record<string, string>;
		readonly ssh: GondolinLeaseResponse['ssh'];
		readonly usePty: boolean;
		readonly workdir: string;
	}) => Promise<{
		readonly argv: string[];
		readonly env: Record<string, string>;
		readonly stdinMode: 'pipe-open' | 'pipe-closed';
	}>;
	readonly createFsBridge?: (params: { readonly sandbox: unknown }) => unknown;
	readonly createLeaseClient?: (options: { readonly controllerUrl: string }) => LeaseClient;
	readonly runRemoteShellScript: (params: {
		readonly script: string;
		readonly ssh: GondolinLeaseResponse['ssh'];
	}) => Promise<{
		readonly code: number;
		readonly stderr: Buffer;
		readonly stdout: Buffer;
	}>;
}

interface GondolinSandboxBackendHandle {
	createFsBridge?: (params: { readonly sandbox: unknown }) => unknown;
	env?: Record<string, string>;
	readonly id: string;
	readonly runtimeId: string;
	readonly runtimeLabel: string;
	readonly workdir: string;
	buildExecSpec(params: {
		readonly command: string;
		readonly env: Record<string, string>;
		readonly usePty: boolean;
		readonly workdir?: string;
	}): Promise<{
		readonly argv: string[];
		readonly env: Record<string, string>;
		readonly stdinMode: 'pipe-open' | 'pipe-closed';
	}>;
	runShellCommand(params: { readonly script: string }): Promise<{
		readonly code: number;
		readonly stderr: Buffer;
		readonly stdout: Buffer;
	}>;
}

export function createGondolinSandboxBackendFactory(
	options: {
		readonly controllerUrl: string;
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
	return async (params) => {
		const leaseClient =
			dependencies.createLeaseClient?.({
				controllerUrl: options.controllerUrl,
			}) ?? createLeaseClient({ controllerUrl: options.controllerUrl });
		const leaseResponse = await leaseClient.requestLease({
			agentWorkspaceDir: params.agentWorkspaceDir,
			profileId: 'standard',
			scopeKey: params.scopeKey,
			workspaceDir: params.workspaceDir,
			zoneId: options.zoneId,
		});
		if (!isGondolinLeaseResponse(leaseResponse)) {
			throw new TypeError('Controller lease API returned an unexpected response.');
		}
		const lease = leaseResponse;

		return {
			...(dependencies.createFsBridge
				? {
						createFsBridge: dependencies.createFsBridge,
					}
				: {}),
			...(params.cfg.docker?.env
				? {
						env: params.cfg.docker.env,
					}
				: {}),
			id: 'gondolin',
			runtimeId: lease.leaseId,
			runtimeLabel: lease.leaseId,
			workdir: lease.workdir,
			buildExecSpec: async (execParams) =>
				await dependencies.buildExecSpec({
					command: execParams.command,
					env: execParams.env,
					ssh: lease.ssh,
					usePty: execParams.usePty,
					workdir: execParams.workdir ?? lease.workdir,
				}),
			runShellCommand: async (commandParams) =>
				await dependencies.runRemoteShellScript({
					script: commandParams.script,
					ssh: lease.ssh,
				}),
		} satisfies GondolinSandboxBackendHandle;
	};
}
