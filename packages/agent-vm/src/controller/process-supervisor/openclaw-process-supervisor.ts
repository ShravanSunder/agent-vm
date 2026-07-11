import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import type { ManagedVm } from '@agent-vm/gondolin-adapter';
import { writeFileAtomically } from '@agent-vm/gondolin-adapter';

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

interface CreateOpenClawProcessSupervisorOptions {
	readonly gateway: OpenClawProcessSupervisorGateway;
	readonly invokeHelper: (
		request: OpenClawProcessSupervisorRequest,
	) => Promise<OpenClawProcessSupervisorReceipt>;
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
	if (
		options.request.kind === 'start' &&
		(options.receipt.kind !== 'start' ||
			options.receipt.observedProcessEpoch !== options.request.selectedProcessEpoch)
	) {
		throw new Error(
			'OpenClaw process supervisor start receipt changed the selected process epoch.',
		);
	}
	if (options.receipt.status !== 'completed') {
		throw new Error(
			`OpenClaw process supervisor ${options.receipt.kind} was ${options.receipt.status}: ${options.receipt.reason ?? 'unknown'}.`,
		);
	}
}

export function createOpenClawProcessSupervisor(
	options: CreateOpenClawProcessSupervisorOptions,
): OpenClawProcessSupervisor {
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

	return {
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
	};
}

export function createManagedVmOpenClawProcessSupervisor(options: {
	readonly gateway: OpenClawProcessSupervisorGateway;
	readonly hostStateDirectory: string;
	readonly vm: Pick<ManagedVm, 'exec' | 'id'>;
}): OpenClawProcessSupervisor {
	if (options.vm.id !== options.gateway.gatewayVmId) {
		throw new Error('OpenClaw process supervisor VM does not match the exact Gateway fence.');
	}
	const requestPath = path.join(options.hostStateDirectory, 'request-v1.json');
	const receiptPath = path.join(options.hostStateDirectory, 'receipt-v1.json');
	return createOpenClawProcessSupervisor({
		gateway: options.gateway,
		invokeHelper: async (request) => {
			await mkdir(options.hostStateDirectory, { mode: 0o700, recursive: true });
			await rm(receiptPath, { force: true });
			await writeFileAtomically(requestPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });
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
					throw new Error(timeoutMessage, {
						cause: receiptError,
					});
				}
				if (helperExitCode !== undefined && helperExitCode !== 0) {
					throw new Error(
						`OpenClaw process supervisor helper failed with exit ${String(helperExitCode)}.`,
						{ cause: receiptError },
					);
				}
				if (helperExecutionError !== undefined) {
					throw new Error('OpenClaw process supervisor helper failed before writing a receipt.', {
						cause: receiptError,
					});
				}
				throw receiptError;
			}
		},
	});
}
