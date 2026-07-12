import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import type { ManagedVm } from '@agent-vm/gondolin-adapter';

import {
	OPENCLAW_PROCESS_SUPERVISOR_GUEST_HELPER_PATH,
	openClawProcessSupervisorReceiptSchema,
	openClawProcessSupervisorRequestSchema,
	type OpenClawProcessSupervisorGateway,
	type OpenClawProcessSupervisorReceipt,
	type OpenClawProcessSupervisorRequest,
} from './openclaw-process-supervisor-contracts.js';

export const OPENCLAW_PROCESS_SUPERVISOR_OPERATION_TIMEOUT_MS = 20_000;

export interface OpenClawProcessSupervisor {
	contain(options: {
		readonly actionId: string;
		readonly expectedProcessEpoch: string;
	}): Promise<OpenClawProcessSupervisorReceipt>;
	observe(options: {
		readonly actionId: string;
		readonly expectedProcessEpoch: string | null;
	}): Promise<OpenClawProcessSupervisorReceipt>;
	start(options: {
		readonly actionId: string;
		readonly expectedProcessEpoch: string | null;
		readonly selectedProcessEpoch: string;
	}): Promise<OpenClawProcessSupervisorReceipt>;
}

export interface OpenClawProcessReliabilityFaultActuator {
	terminateOwnedProcess(options: {
		readonly actionId: string;
		readonly expectedProcessEpoch: string;
	}): Promise<OpenClawProcessSupervisorReceipt>;
}

export interface OpenClawProcessSupervisorPorts {
	readonly reliabilityFaultActuator: OpenClawProcessReliabilityFaultActuator;
	readonly supervisor: OpenClawProcessSupervisor;
}

interface CreateOpenClawProcessSupervisorOptions {
	readonly gateway: OpenClawProcessSupervisorGateway;
	readonly invokeHelper: (
		request: OpenClawProcessSupervisorRequest,
	) => Promise<OpenClawProcessSupervisorReceipt>;
}

type NonCompletedOpenClawProcessSupervisorReceipt = Extract<
	OpenClawProcessSupervisorReceipt,
	{ readonly status: 'incomplete' | 'refused' }
>;

export class OpenClawProcessSupervisorReceiptError extends Error {
	readonly receipt: NonCompletedOpenClawProcessSupervisorReceipt;

	constructor(receipt: NonCompletedOpenClawProcessSupervisorReceipt) {
		super(
			`OpenClaw process supervisor ${receipt.kind} was ${receipt.status}: ${receipt.reason ?? 'unknown'}.`,
		);
		this.name = 'OpenClawProcessSupervisorReceiptError';
		this.receipt = receipt;
	}
}

export type OpenClawProcessSupervisorInvocationErrorCode =
	| 'helper-execution'
	| 'helper-exit'
	| 'helper-lock-contended'
	| 'helper-timeout'
	| 'receipt-invalid';

export class OpenClawProcessSupervisorInvocationError extends Error {
	readonly code: OpenClawProcessSupervisorInvocationErrorCode;

	constructor(code: OpenClawProcessSupervisorInvocationErrorCode, options?: ErrorOptions) {
		super(`OpenClaw process supervisor invocation failed: ${code}.`, options);
		this.name = 'OpenClawProcessSupervisorInvocationError';
		this.code = code;
	}
}

function gatewaysEqual(
	left: OpenClawProcessSupervisorGateway,
	right: OpenClawProcessSupervisorGateway,
): boolean {
	return (
		left.controllerEpoch === right.controllerEpoch &&
		left.gatewayEpochId === right.gatewayEpochId &&
		left.gatewayVmId === right.gatewayVmId
	);
}

function assertReceiptMatchesRequest(options: {
	readonly receipt: OpenClawProcessSupervisorReceipt;
	readonly request: OpenClawProcessSupervisorRequest;
}): void {
	if (options.receipt.actionId !== options.request.actionId) {
		throw new Error('OpenClaw process supervisor receipt changed the exact action fence.');
	}
	if (
		options.receipt.kind !== options.request.kind ||
		options.receipt.expectedProcessEpoch !== options.request.expectedProcessEpoch ||
		!gatewaysEqual(options.receipt.gateway, options.request.gateway)
	) {
		throw new Error('OpenClaw process supervisor receipt changed the exact Gateway/process fence.');
	}
	if (options.receipt.status !== 'completed') {
		throw new OpenClawProcessSupervisorReceiptError(options.receipt);
	}
	if (
		options.request.kind === 'start' &&
		(options.receipt.kind !== 'start' ||
			options.receipt.observedProcessEpoch !== options.request.selectedProcessEpoch)
	) {
		throw new Error(
			'OpenClaw process supervisor start receipt changed the selected process epoch.',
		);
	}
}

export function createOpenClawProcessSupervisorPorts(
	options: CreateOpenClawProcessSupervisorOptions,
): OpenClawProcessSupervisorPorts {
	let operationTail = Promise.resolve();
	const runSerialized = async (
		untrustedRequest: OpenClawProcessSupervisorRequest,
	): Promise<OpenClawProcessSupervisorReceipt> => {
		const request = openClawProcessSupervisorRequestSchema.parse(untrustedRequest);
		const priorOperation = operationTail;
		let releaseOperation: (() => void) | undefined;
		operationTail = new Promise<void>((resolve) => {
			releaseOperation = resolve;
		});
		await priorOperation.catch(() => undefined);
		try {
			const receipt = openClawProcessSupervisorReceiptSchema.parse(
				await options.invokeHelper(request),
			);
			assertReceiptMatchesRequest({ receipt, request });
			return receipt;
		} finally {
			releaseOperation?.();
		}
	};

	const supervisor = {
		async contain(requestOptions) {
			return await runSerialized({
				...requestOptions,
				contractVersion: 1,
				gateway: options.gateway,
				kind: 'contain',
			});
		},
		async observe(requestOptions) {
			return await runSerialized({
				...requestOptions,
				contractVersion: 1,
				gateway: options.gateway,
				kind: 'observe',
			});
		},
		async start(requestOptions) {
			return await runSerialized({
				...requestOptions,
				contractVersion: 1,
				gateway: options.gateway,
				kind: 'start',
			});
		},
	} satisfies OpenClawProcessSupervisor;
	const reliabilityFaultActuator = {
		async terminateOwnedProcess(requestOptions) {
			return await runSerialized({
				...requestOptions,
				contractVersion: 1,
				gateway: options.gateway,
				kind: 'terminate-for-reliability-test',
			});
		},
	} satisfies OpenClawProcessReliabilityFaultActuator;
	return { reliabilityFaultActuator, supervisor };
}

export function createOpenClawProcessSupervisor(
	options: CreateOpenClawProcessSupervisorOptions,
): OpenClawProcessSupervisor {
	return createOpenClawProcessSupervisorPorts(options).supervisor;
}

export function createManagedVmOpenClawProcessSupervisorPorts(options: {
	readonly gateway: OpenClawProcessSupervisorGateway;
	readonly hostStateDirectory: string;
	readonly vm: Pick<ManagedVm, 'exec' | 'id'>;
}): OpenClawProcessSupervisorPorts {
	if (options.vm.id !== options.gateway.gatewayVmId) {
		throw new Error('OpenClaw process supervisor VM does not match the exact Gateway fence.');
	}
	const receiptPath = path.join(options.hostStateDirectory, 'receipt-v1.json');
	return createOpenClawProcessSupervisorPorts({
		gateway: options.gateway,
		invokeHelper: async (request) => {
			await mkdir(options.hostStateDirectory, { mode: 0o700, recursive: true });
			await rm(receiptPath, { force: true });
			const operationAbortController = new AbortController();
			const timeoutMessage = `OpenClaw process supervisor helper timed out after ${String(OPENCLAW_PROCESS_SUPERVISOR_OPERATION_TIMEOUT_MS)}ms.`;
			const timeout = setTimeout(() => {
				operationAbortController.abort(new Error(timeoutMessage));
			}, OPENCLAW_PROCESS_SUPERVISOR_OPERATION_TIMEOUT_MS);
			let helperExitCode: number | undefined;
			let helperExecutionError: unknown;
			try {
				const result = await options.vm.exec([OPENCLAW_PROCESS_SUPERVISOR_GUEST_HELPER_PATH], {
					signal: operationAbortController.signal,
					stdin: `${JSON.stringify(request)}\n`,
				});
				helperExitCode = result.exitCode;
			} catch (error: unknown) {
				helperExecutionError = error;
			} finally {
				clearTimeout(timeout);
			}
			try {
				return openClawProcessSupervisorReceiptSchema.parse(
					JSON.parse(await readFile(receiptPath, 'utf8')),
				);
			} catch (receiptError: unknown) {
				if (operationAbortController.signal.aborted) {
					throw new OpenClawProcessSupervisorInvocationError('helper-timeout', {
						cause: receiptError,
					});
				}
				if (helperExitCode !== undefined && helperExitCode !== 0) {
					throw new OpenClawProcessSupervisorInvocationError(
						helperExitCode === 73 ? 'helper-lock-contended' : 'helper-exit',
						{
							cause: receiptError,
						},
					);
				}
				if (helperExecutionError !== undefined) {
					throw new OpenClawProcessSupervisorInvocationError('helper-execution', {
						cause: receiptError,
					});
				}
				throw new OpenClawProcessSupervisorInvocationError('receipt-invalid', {
					cause: receiptError,
				});
			}
		},
	});
}

export function createManagedVmOpenClawProcessSupervisor(options: {
	readonly gateway: OpenClawProcessSupervisorGateway;
	readonly hostStateDirectory: string;
	readonly vm: Pick<ManagedVm, 'exec' | 'id'>;
}): OpenClawProcessSupervisor {
	return createManagedVmOpenClawProcessSupervisorPorts(options).supervisor;
}
