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
} from './openclaw-process-supervisor.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map(async (directory) => await rm(directory, { force: true, recursive: true })),
	);
});

describe('managed VM OpenClaw process supervisor adapter', () => {
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
		let releaseHelper: (() => void) | undefined;
		const helperMayFinish = new Promise<void>((resolve) => {
			releaseHelper = resolve;
		});
		const exec = vi.fn<Pick<ManagedVm, 'exec'>['exec']>((command) => {
			expect(command).toEqual([OPENCLAW_PROCESS_SUPERVISOR_GUEST_HELPER_PATH]);
			return createManagedExecProcessStub({
				exitCode: 0,
				stderr: '',
				stdout: '',
				waitFor: helperMayFinish,
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
		await vi.waitFor(async () => {
			const request = openClawProcessSupervisorRequestSchema.parse(
				JSON.parse(await readFile(path.join(hostStateDirectory, 'request-v1.json'), 'utf8')),
			);
			if (request.kind !== 'start') {
				throw new Error(`Expected start request, received '${request.kind}'.`);
			}
			expect(request).toMatchObject({
				actionId: 'action-start-1',
				gateway,
				kind: 'start',
				selectedProcessEpoch: 'process-1',
			});
			await writeFile(
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
			);
		});
		releaseHelper?.();

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
		const exec = vi.fn<Pick<ManagedVm, 'exec'>['exec']>(() => {
			const writeReceiptBeforeExit = (async (): Promise<void> => {
				const request = openClawProcessSupervisorRequestSchema.parse(
					JSON.parse(await readFile(path.join(hostStateDirectory, 'request-v1.json'), 'utf8')),
				);
				await writeFile(
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
				);
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
				waitFor: writeReceiptBeforeExit,
			});
		});
		const supervisor = createManagedVmOpenClawProcessSupervisor({
			gateway,
			hostStateDirectory,
			vm: { exec, id: gateway.gatewayVmId },
		});

		await expect(
			supervisor.observe({ actionId: 'action-observe-1', expectedProcessEpoch: null }),
		).rejects.toThrow('OpenClaw process supervisor helper failed with exit 9.');
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
			const operation = supervisor.observe({
				actionId: 'action-timeout-1',
				expectedProcessEpoch: null,
			});

			await vi.waitFor(() => expect(exec).toHaveBeenCalledOnce());
			await vi.advanceTimersByTimeAsync(OPENCLAW_PROCESS_SUPERVISOR_OPERATION_TIMEOUT_MS);
			await expect(operation).rejects.toThrow(
				`OpenClaw process supervisor helper timed out after ${String(OPENCLAW_PROCESS_SUPERVISOR_OPERATION_TIMEOUT_MS)}ms.`,
			);
		} finally {
			vi.useRealTimers();
		}
	});
});
