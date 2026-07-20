import type {
	SandboxOperationControlResult,
	SandboxProcessCancelRequest,
	SandboxProcessLogsRequest,
	SandboxProcessLogsResult,
	SandboxProcessStartResult,
	SandboxProcessStatusRequest,
	SandboxProcessStatusResult,
	SandboxProcessWaitRequest,
	SandboxStreamCloseRequest,
	SandboxStreamCloseResult,
	SandboxStreamReadRequest,
	SandboxStreamReadResult,
	SandboxStreamWriteRequest,
	SandboxStreamWriteResult,
} from '@agent-vm/agent-portal-sdk';

import type {
	GatewayRuntimeSandboxOperationAuthority,
	GatewayRuntimeSandboxOperationContext,
} from './sandbox-operation-authority.js';
import type {
	ResolvedStrictToolVmSshProcessStartRequest,
	ResolvedStrictToolVmSshShellProcessStartRequest,
	StrictToolVmSshProcessRuntime,
} from './strict-tool-vm-ssh-process-runtime.js';
import { StrictToolVmSshProcessStartError } from './strict-tool-vm-ssh-process-runtime.js';

export interface GatewayRuntimeSandboxProcessRegistry {
	readonly cancel: (request: SandboxProcessCancelRequest) => SandboxOperationControlResult;
	readonly closeStream: (request: SandboxStreamCloseRequest) => SandboxStreamCloseResult;
	readonly logs: (request: SandboxProcessLogsRequest) => SandboxProcessLogsResult;
	readonly read: (request: SandboxStreamReadRequest) => SandboxStreamReadResult;
	readonly retire: () => Promise<void>;
	readonly start: (
		request: ResolvedStrictToolVmSshProcessStartRequest,
	) => Promise<SandboxProcessStartResult>;
	readonly startShell: (
		request: ResolvedStrictToolVmSshShellProcessStartRequest,
	) => Promise<SandboxProcessStartResult>;
	readonly status: (request: SandboxProcessStatusRequest) => SandboxProcessStatusResult;
	readonly terminalExitCode: (request: SandboxProcessStatusRequest) => number | undefined;
	readonly wait: (request: SandboxProcessWaitRequest) => Promise<SandboxProcessStatusResult>;
	readonly write: (request: SandboxStreamWriteRequest) => Promise<SandboxStreamWriteResult>;
	readonly resizeTerminal: StrictToolVmSshProcessRuntime['resizeTerminal'];
}

export function createGatewayRuntimeSandboxProcessRegistry(options: {
	readonly operationAuthority: GatewayRuntimeSandboxOperationAuthority;
	readonly operationContext: GatewayRuntimeSandboxOperationContext;
	readonly processRuntime: StrictToolVmSshProcessRuntime;
}): GatewayRuntimeSandboxProcessRegistry {
	let retired = false;
	let retirementPromise: Promise<void> | undefined;
	const requireCurrentAuthority = (): void => {
		if (retired) throw new Error('Sandbox process registry is retired.');
		if (options.operationAuthority.authorize(options.operationContext).kind !== 'authorized') {
			throw new Error('Sandbox process registry authority is stale.');
		}
	};

	const cancel: GatewayRuntimeSandboxProcessRegistry['cancel'] = (request) => {
		requireCurrentAuthority();
		return options.processRuntime.cancel(request);
	};
	const closeStream: GatewayRuntimeSandboxProcessRegistry['closeStream'] = (request) => {
		requireCurrentAuthority();
		return options.processRuntime.closeStream(request);
	};
	const logs: GatewayRuntimeSandboxProcessRegistry['logs'] = (request) => {
		requireCurrentAuthority();
		return options.processRuntime.logs(request);
	};
	const read: GatewayRuntimeSandboxProcessRegistry['read'] = (request) => {
		requireCurrentAuthority();
		return options.processRuntime.read(request);
	};
	const start: GatewayRuntimeSandboxProcessRegistry['start'] = async (request) => {
		try {
			requireCurrentAuthority();
		} catch (error: unknown) {
			throw new StrictToolVmSshProcessStartError({
				cause: error,
				disposition: 'not-dispatched',
				message: 'Sandbox process start authority is stale or retired.',
			});
		}
		return await options.processRuntime.start(request);
	};
	const status: GatewayRuntimeSandboxProcessRegistry['status'] = (request) => {
		requireCurrentAuthority();
		return options.processRuntime.status(request);
	};
	const terminalExitCode: GatewayRuntimeSandboxProcessRegistry['terminalExitCode'] = (request) => {
		requireCurrentAuthority();
		return options.processRuntime.terminalExitCode(request);
	};
	const startShell: GatewayRuntimeSandboxProcessRegistry['startShell'] = async (request) => {
		try {
			requireCurrentAuthority();
		} catch (error: unknown) {
			throw new StrictToolVmSshProcessStartError({
				cause: error,
				disposition: 'not-dispatched',
				message: 'Sandbox shell process start authority is stale or retired.',
			});
		}
		return await options.processRuntime.startShell(request);
	};
	const resizeTerminal: GatewayRuntimeSandboxProcessRegistry['resizeTerminal'] = (request) => {
		requireCurrentAuthority();
		options.processRuntime.resizeTerminal(request);
	};
	const wait: GatewayRuntimeSandboxProcessRegistry['wait'] = async (request) => {
		requireCurrentAuthority();
		return await options.processRuntime.wait(request);
	};
	const write: GatewayRuntimeSandboxProcessRegistry['write'] = async (request) => {
		requireCurrentAuthority();
		return await options.processRuntime.write(request);
	};
	const retire: GatewayRuntimeSandboxProcessRegistry['retire'] = () => {
		if (retirementPromise !== undefined) return retirementPromise;
		retired = true;
		retirementPromise = Promise.resolve().then(async () => await options.processRuntime.retire());
		return retirementPromise;
	};

	return {
		cancel,
		closeStream,
		logs,
		read,
		resizeTerminal,
		retire,
		start,
		startShell,
		status,
		terminalExitCode,
		wait,
		write,
	};
}
