import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ManagedVm } from '@agent-vm/gondolin-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagedExecProcessStub } from '../../testing/managed-vm-test-helpers.js';
import {
	OPENCLAW_PROCESS_SUPERVISOR_GUEST_HELPER_PATH,
	openClawProcessSupervisorRequestSchema,
} from './openclaw-process-supervisor-contracts.js';
import {
	OPENCLAW_PROCESS_SUPERVISOR_OPERATION_TIMEOUT_MS,
	createManagedVmOpenClawProcessSupervisor,
	createManagedVmOpenClawProcessSupervisorPorts,
} from './openclaw-process-supervisor.js';

const temporaryDirectories: string[] = [];

function requireSerializedRequestStdin(stdin: unknown): string {
	if (typeof stdin !== 'string') {
		throw new Error('Expected the process supervisor request as exact string stdin.');
	}
	return stdin;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map(async (directory) => await rm(directory, { force: true, recursive: true })),
	);
});

describe('managed VM OpenClaw process supervisor adapter', () => {
	it('invokes the fixed helper argv for an exact reliability-test process termination', async () => {
		const hostStateDirectory = await mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-openclaw-process-reliability-actuator-'),
		);
		temporaryDirectories.push(hostStateDirectory);
		const gateway = {
			controllerEpoch: 'controller-1',
			gatewayEpochId: 'gateway-epoch-1',
			gatewayVmId: 'gateway-vm-1',
		} as const;
		const exec = vi.fn<Pick<ManagedVm, 'exec'>['exec']>((command, options) => {
			expect(command).toEqual([OPENCLAW_PROCESS_SUPERVISOR_GUEST_HELPER_PATH]);
			const writeReceiptBeforeExit = (async (): Promise<void> => {
				await expect(
					readFile(path.join(hostStateDirectory, 'request-v1.json'), 'utf8'),
				).rejects.toMatchObject({ code: 'ENOENT' });
				const serializedRequest = requireSerializedRequestStdin(options?.stdin);
				expect(serializedRequest).toBe(
					`${JSON.stringify({
						actionId: 'action-reliability-terminate-1',
						contractVersion: 1,
						expectedProcessEpoch: 'process-1',
						gateway,
						kind: 'terminate-for-reliability-test',
					})}\n`,
				);
				const request = openClawProcessSupervisorRequestSchema.parse(JSON.parse(serializedRequest));
				expect(request).toEqual({
					actionId: 'action-reliability-terminate-1',
					contractVersion: 1,
					expectedProcessEpoch: 'process-1',
					gateway,
					kind: 'terminate-for-reliability-test',
				});
				await Promise.all([
					writeFile(path.join(hostStateDirectory, 'request-v1.json'), serializedRequest, 'utf8'),
					writeFile(
						path.join(hostStateDirectory, 'receipt-v1.json'),
						`${JSON.stringify({
							actionId: request.actionId,
							cgroup: {
								emptyObserved: true,
								name: 'agent-vm-process-1',
								populated: false,
							},
							contractVersion: 1,
							expectedProcessEpoch: request.expectedProcessEpoch,
							gateway: request.gateway,
							kind: request.kind,
							observedProcessEpoch: 'process-1',
							status: 'completed',
						})}\n`,
						'utf8',
					),
				]);
			})();
			return createManagedExecProcessStub({
				exitCode: 0,
				waitFor: writeReceiptBeforeExit,
			});
		});
		const { reliabilityFaultActuator } = createManagedVmOpenClawProcessSupervisorPorts({
			gateway,
			hostStateDirectory,
			vm: { exec, id: gateway.gatewayVmId },
		});

		await expect(
			reliabilityFaultActuator.terminateOwnedProcess({
				actionId: 'action-reliability-terminate-1',
				expectedProcessEpoch: 'process-1',
			}),
		).resolves.toMatchObject({
			expectedProcessEpoch: 'process-1',
			kind: 'terminate-for-reliability-test',
			observedProcessEpoch: 'process-1',
		});
		expect(exec).toHaveBeenCalledOnce();
	});

	it('writes one strict request, invokes only the fixed helper argv, and accepts a fenced receipt', async () => {
		const hostStateDirectory = await mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-openclaw-process-supervisor-'),
		);
		temporaryDirectories.push(hostStateDirectory);
		const gateway = {
			controllerEpoch: 'controller-1',
			gatewayEpochId: 'gateway-epoch-1',
			gatewayVmId: 'gateway-vm-1',
		} as const;
		const exec = vi.fn<Pick<ManagedVm, 'exec'>['exec']>((command, options) => {
			expect(command).toEqual([OPENCLAW_PROCESS_SUPERVISOR_GUEST_HELPER_PATH]);
			const simulateGuestHelper = (async (): Promise<void> => {
				await expect(
					readFile(path.join(hostStateDirectory, 'request-v1.json'), 'utf8'),
				).rejects.toMatchObject({ code: 'ENOENT' });
				const serializedRequest = requireSerializedRequestStdin(options?.stdin);
				const request = openClawProcessSupervisorRequestSchema.parse(JSON.parse(serializedRequest));
				if (request.kind !== 'start') {
					throw new Error(`Expected start request, received '${request.kind}'.`);
				}
				expect(serializedRequest).toBe(`${JSON.stringify(request)}\n`);
				await Promise.all([
					writeFile(path.join(hostStateDirectory, 'request-v1.json'), serializedRequest, 'utf8'),
					writeFile(
						path.join(hostStateDirectory, 'receipt-v1.json'),
						`${JSON.stringify({
							actionId: request.actionId,
							cgroup: { name: 'agent-vm-process-1', populated: true },
							contractVersion: 1,
							expectedProcessEpoch: request.expectedProcessEpoch,
							gateway: request.gateway,
							kind: request.kind,
							observedProcessEpoch: request.selectedProcessEpoch,
							status: 'completed',
						})}\n`,
						'utf8',
					),
				]);
			})();
			return createManagedExecProcessStub({
				exitCode: 0,
				stderr: '',
				stdout: '',
				waitFor: simulateGuestHelper,
			});
		});
		const supervisor = createManagedVmOpenClawProcessSupervisor({
			gateway,
			hostStateDirectory,
			vm: { exec, id: gateway.gatewayVmId },
		});
		const operation = supervisor.start({
			actionId: 'action-start-1',
			expectedProcessEpoch: null,
			selectedProcessEpoch: 'process-1',
		});
		await expect(operation).resolves.toMatchObject({
			actionId: 'action-start-1',
			observedProcessEpoch: 'process-1',
		});
		expect(exec).toHaveBeenCalledOnce();
	});

	it('returns an exact typed refused receipt from a nonzero helper exit', async () => {
		const hostStateDirectory = await mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-openclaw-process-supervisor-refused-'),
		);
		temporaryDirectories.push(hostStateDirectory);
		const gateway = {
			controllerEpoch: 'controller-1',
			gatewayEpochId: 'gateway-epoch-1',
			gatewayVmId: 'gateway-vm-1',
		} as const;
		const exec = vi.fn<Pick<ManagedVm, 'exec'>['exec']>((_command, options) => {
			const writeReceiptBeforeExit = (async (): Promise<void> => {
				await expect(
					readFile(path.join(hostStateDirectory, 'request-v1.json'), 'utf8'),
				).rejects.toMatchObject({ code: 'ENOENT' });
				const serializedRequest = requireSerializedRequestStdin(options?.stdin);
				const request = openClawProcessSupervisorRequestSchema.parse(JSON.parse(serializedRequest));
				await Promise.all([
					writeFile(path.join(hostStateDirectory, 'request-v1.json'), serializedRequest, 'utf8'),
					writeFile(
						path.join(hostStateDirectory, 'receipt-v1.json'),
						`${JSON.stringify({
							actionId: request.actionId,
							cgroup: { name: 'agent-vm-process-1', populated: true },
							contractVersion: 1,
							expectedProcessEpoch: request.expectedProcessEpoch,
							gateway: request.gateway,
							kind: request.kind,
							observedProcessEpoch:
								request.kind === 'start'
									? request.selectedProcessEpoch
									: request.expectedProcessEpoch,
							reason: 'process-overlap',
							status: 'refused',
						})}\n`,
						'utf8',
					),
				]);
			})();
			return createManagedExecProcessStub({
				exitCode: 2,
				waitFor: writeReceiptBeforeExit,
			});
		});
		const supervisor = createManagedVmOpenClawProcessSupervisor({
			gateway,
			hostStateDirectory,
			vm: { exec, id: gateway.gatewayVmId },
		});

		await expect(
			supervisor.start({
				actionId: 'action-refused-1',
				expectedProcessEpoch: null,
				selectedProcessEpoch: 'process-1',
			}),
		).rejects.toThrow('OpenClaw process supervisor start was refused: process-overlap.');
	});

	it.each([
		{ name: 'missing', receipt: undefined },
		{ name: 'invalid', receipt: '{"status":"refused"}\n' },
	])('reports helper failure for a $name receipt after nonzero exit', async ({ receipt }) => {
		const hostStateDirectory = await mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-openclaw-process-supervisor-invalid-'),
		);
		temporaryDirectories.push(hostStateDirectory);
		const gateway = {
			controllerEpoch: 'controller-1',
			gatewayEpochId: 'gateway-epoch-1',
			gatewayVmId: 'gateway-vm-1',
		} as const;
		const exec = vi.fn<Pick<ManagedVm, 'exec'>['exec']>(() => {
			const writeReceiptBeforeExit = (async (): Promise<void> => {
				if (receipt !== undefined) {
					await writeFile(path.join(hostStateDirectory, 'receipt-v1.json'), receipt, 'utf8');
				}
			})();
			return createManagedExecProcessStub({
				exitCode: 9,
				stderr: `private helper stderr with ${hostStateDirectory}`,
				waitFor: writeReceiptBeforeExit,
			});
		});
		const supervisor = createManagedVmOpenClawProcessSupervisor({
			gateway,
			hostStateDirectory,
			vm: { exec, id: gateway.gatewayVmId },
		});

		const invocationError = await supervisor
			.observe({ actionId: 'action-observe-1', expectedProcessEpoch: null })
			.catch((error: unknown) => error);

		expect(invocationError).toMatchObject({
			code: 'helper-exit',
			message: 'OpenClaw process supervisor invocation failed: helper-exit.',
			name: 'OpenClawProcessSupervisorInvocationError',
		});
		expect((invocationError as Error).message).not.toContain('private helper stderr');
		expect((invocationError as Error).message).not.toContain(hostStateDirectory);
	});

	it('classifies helper exit 73 as bounded lock contention without exposing stderr or paths', async () => {
		const hostStateDirectory = await mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-openclaw-process-supervisor-lock-contended-'),
		);
		temporaryDirectories.push(hostStateDirectory);
		const gateway = {
			controllerEpoch: 'controller-1',
			gatewayEpochId: 'gateway-epoch-1',
			gatewayVmId: 'gateway-vm-1',
		} as const;
		const rawStderr = `private lock owner details at ${hostStateDirectory}`;
		const supervisor = createManagedVmOpenClawProcessSupervisor({
			gateway,
			hostStateDirectory,
			vm: {
				exec: vi.fn(() =>
					createManagedExecProcessStub({
						exitCode: 73,
						stderr: rawStderr,
					}),
				),
				id: gateway.gatewayVmId,
			},
		});

		const invocationError = await supervisor
			.start({
				actionId: 'action-lock-contended-1',
				expectedProcessEpoch: null,
				selectedProcessEpoch: 'process-1',
			})
			.catch((error: unknown) => error);

		expect(invocationError).toMatchObject({
			code: 'helper-lock-contended',
			message: 'OpenClaw process supervisor invocation failed: helper-lock-contended.',
			name: 'OpenClawProcessSupervisorInvocationError',
		});
		expect((invocationError as Error).message).not.toContain('73');
		expect((invocationError as Error).message).not.toContain(rawStderr);
		expect((invocationError as Error).message).not.toContain(hostStateDirectory);
	});

	it('reports a bounded helper-execution code without exposing the execution payload', async () => {
		const hostStateDirectory = await mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-openclaw-process-supervisor-execution-'),
		);
		temporaryDirectories.push(hostStateDirectory);
		const gateway = {
			controllerEpoch: 'controller-1',
			gatewayEpochId: 'gateway-epoch-1',
			gatewayVmId: 'gateway-vm-1',
		} as const;
		const rawExecutionPayload = `private exec failure at ${hostStateDirectory}`;
		const supervisor = createManagedVmOpenClawProcessSupervisor({
			gateway,
			hostStateDirectory,
			vm: {
				exec: vi.fn(() =>
					createManagedExecProcessStub({
						waitFor: Promise.reject(new Error(rawExecutionPayload)),
					}),
				),
				id: gateway.gatewayVmId,
			},
		});

		const invocationError = await supervisor
			.observe({ actionId: 'action-execution-1', expectedProcessEpoch: null })
			.catch((error: unknown) => error);

		expect(invocationError).toMatchObject({
			code: 'helper-execution',
			message: 'OpenClaw process supervisor invocation failed: helper-execution.',
			name: 'OpenClawProcessSupervisorInvocationError',
		});
		expect((invocationError as Error).message).not.toContain(rawExecutionPayload);
		expect((invocationError as Error).message).not.toContain(hostStateDirectory);
	});

	it('reports a bounded receipt-invalid code after a zero helper exit', async () => {
		const hostStateDirectory = await mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-openclaw-process-supervisor-receipt-invalid-'),
		);
		temporaryDirectories.push(hostStateDirectory);
		const gateway = {
			controllerEpoch: 'controller-1',
			gatewayEpochId: 'gateway-epoch-1',
			gatewayVmId: 'gateway-vm-1',
		} as const;
		const exec = vi.fn<Pick<ManagedVm, 'exec'>['exec']>(() => {
			const writeInvalidReceipt = writeFile(
				path.join(hostStateDirectory, 'receipt-v1.json'),
				'{"privatePath":"/private/raw/receipt-path"}\n',
				'utf8',
			);
			return createManagedExecProcessStub({ exitCode: 0, waitFor: writeInvalidReceipt });
		});
		const supervisor = createManagedVmOpenClawProcessSupervisor({
			gateway,
			hostStateDirectory,
			vm: { exec, id: gateway.gatewayVmId },
		});

		const invocationError = await supervisor
			.observe({ actionId: 'action-invalid-receipt-1', expectedProcessEpoch: null })
			.catch((error: unknown) => error);

		expect(invocationError).toMatchObject({
			code: 'receipt-invalid',
			message: 'OpenClaw process supervisor invocation failed: receipt-invalid.',
			name: 'OpenClawProcessSupervisorInvocationError',
		});
		expect((invocationError as Error).message).not.toContain('/private/raw/receipt-path');
		expect((invocationError as Error).message).not.toContain(hostStateDirectory);
	});

	it('bounds helper execution to twenty seconds with Gondolin cancellation', async () => {
		vi.useFakeTimers();
		try {
			const hostStateDirectory = await mkdtemp(
				path.join(os.tmpdir(), 'agent-vm-openclaw-process-supervisor-timeout-'),
			);
			temporaryDirectories.push(hostStateDirectory);
			const gateway = {
				controllerEpoch: 'controller-1',
				gatewayEpochId: 'gateway-epoch-1',
				gatewayVmId: 'gateway-vm-1',
			} as const;
			const exec = vi.fn<Pick<ManagedVm, 'exec'>['exec']>((_command, options) => {
				expect(options?.signal).toBeDefined();
				const waitForAbort = new Promise<void>((_resolve, reject) => {
					options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
						once: true,
					});
				});
				return createManagedExecProcessStub({ waitFor: waitForAbort });
			});
			const supervisor = createManagedVmOpenClawProcessSupervisor({
				gateway,
				hostStateDirectory,
				vm: { exec, id: gateway.gatewayVmId },
			});
			const operationOutcome = supervisor
				.observe({
					actionId: 'action-timeout-1',
					expectedProcessEpoch: null,
				})
				.catch((error: unknown) => error);

			await vi.waitFor(() => expect(exec).toHaveBeenCalledOnce());
			await vi.advanceTimersByTimeAsync(OPENCLAW_PROCESS_SUPERVISOR_OPERATION_TIMEOUT_MS);
			const invocationError = await operationOutcome;
			expect(invocationError).toMatchObject({
				code: 'helper-timeout',
				message: 'OpenClaw process supervisor invocation failed: helper-timeout.',
				name: 'OpenClawProcessSupervisorInvocationError',
			});
		} finally {
			vi.useRealTimers();
		}
	});
});
