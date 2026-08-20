import type {
	ManagedVm,
	ManagedVmExactProcessTerminationCapability,
	ManagedVmFactory,
} from '@agent-vm/managed-vm';

import { terminateLiveManagedVm } from '../../shared/controller-managed-vm-termination.js';
import { projectConfiguredCliBufferedOutput } from './configured-cli-output.js';
import { ConfiguredControllerExecutionError } from './configured-controller-execution-error.js';
import type {
	ControllerRunnerAuthorizationSnapshot,
	ManagedVmControllerRunnerFactory,
	ManagedVmControllerRunnerHandle,
} from './managed-vm-controller-runner.js';

const ephemeralRunnerResources = {
	cpuCount: 2,
	memory: '2G',
} as const;

function createRunnerHandle(props: {
	readonly exactProcessTermination: ManagedVmExactProcessTerminationCapability;
	readonly sleep: (delayMs: number) => Promise<void>;
	readonly vm: ManagedVm;
}): ManagedVmControllerRunnerHandle {
	const vm = props.vm;
	return {
		close: async (identity) => {
			if (identity === undefined) {
				if (vm.getHostProcessId() !== null) {
					throw new Error('Configured runner identity is unavailable before close.');
				}
				await vm.close();
				return;
			}
			await terminateLiveManagedVm({
				exactProcessTermination: props.exactProcessTermination,
				sleep: props.sleep,
				target: {
					hostPid: identity.hostProcessId,
					processIdentity: {
						command: identity.command,
						lstart: identity.processStartIdentity,
					},
					vmId: identity.vmId,
				},
				vm,
			});
		},
		exec: async (request) => {
			const commandTimeout = new AbortController();
			const commandTimer = setTimeout(
				() =>
					commandTimeout.abort(
						new ConfiguredControllerExecutionError(
							'timeout',
							'Configured Managed VM execution timed out.',
						),
					),
				request.timeoutMs,
			);
			const executionSignal =
				request.signal === undefined
					? commandTimeout.signal
					: AbortSignal.any([commandTimeout.signal, request.signal]);
			try {
				const process = vm.exec(request.argv, {
					cwd: request.cwd,
					env: request.environment,
					output: {
						stderr: { kind: 'pipe' },
						stdout: { kind: 'pipe' },
						windowBytes: Math.max(request.output.stderrMaxBytes, request.output.stdoutMaxBytes),
					},
					pty: false,
					signal: executionSignal,
					...(request.stdin === undefined ? {} : { stdin: request.stdin }),
				});
				const stdoutChunks: Buffer[] = [];
				const stderrChunks: Buffer[] = [];
				let stdoutBytes = 0;
				let stderrBytes = 0;
				const drainOutput = async (): Promise<void> => {
					for await (const chunk of process.output()) {
						const chunks = chunk.stream === 'stdout' ? stdoutChunks : stderrChunks;
						const currentBytes = chunk.stream === 'stdout' ? stdoutBytes : stderrBytes;
						const maximumBytes =
							chunk.stream === 'stdout'
								? request.output.stdoutMaxBytes
								: request.output.stderrMaxBytes;
						const retainedBytes = Math.max(0, maximumBytes + 1 - currentBytes);
						if (retainedBytes > 0) {
							chunks.push(Buffer.from(chunk.data).subarray(0, retainedBytes));
						}
						if (chunk.stream === 'stdout') stdoutBytes += chunk.data.byteLength;
						else stderrBytes += chunk.data.byteLength;
					}
				};
				const [execution] = await Promise.all([process.result, drainOutput()]);
				const stdout = Buffer.concat(stdoutChunks);
				const stderr = Buffer.concat(stderrChunks);
				return projectConfiguredCliBufferedOutput({
					exitCode: execution.exitCode,
					output: request.output,
					stderr,
					stdout,
				});
			} catch (error) {
				if (executionSignal.aborted) {
					throw executionSignal.reason instanceof ConfiguredControllerExecutionError
						? executionSignal.reason
						: new ConfiguredControllerExecutionError(
								'cancelled',
								'Configured Managed VM execution was cancelled.',
							);
				}
				throw error;
			} finally {
				clearTimeout(commandTimer);
			}
		},
		getHostProcessId: () => vm.getHostProcessId(),
		id: vm.id,
		start: async () => await vm.start(),
	};
}

export function createConfiguredCliManagedVmRunnerFactory(props: {
	readonly exactProcessTermination: ManagedVmExactProcessTerminationCapability;
	readonly managedVmFactory: ManagedVmFactory;
	readonly sessionLabel: string;
	readonly sleep?: (delayMs: number) => Promise<void>;
}): ManagedVmControllerRunnerFactory {
	return {
		create: async (
			authorization: ControllerRunnerAuthorizationSnapshot,
		): Promise<ManagedVmControllerRunnerHandle> => {
			const vm = await props.managedVmFactory.createManagedVm({
				allowedHosts: authorization.egress.allowedHosts,
				environment: authorization.environment,
				imageReference: authorization.imageReference,
				mediatedSecrets: [],
				mounts: {},
				resources: ephemeralRunnerResources,
				rootfsMode: 'cow',
				sessionLabel: props.sessionLabel,
				tcpHosts: [],
			});
			return createRunnerHandle({
				exactProcessTermination: props.exactProcessTermination,
				sleep:
					props.sleep ??
					(async (delayMs) =>
						await new Promise<void>((resolve) => {
							setTimeout(resolve, delayMs);
						})),
				vm,
			});
		},
	};
}
