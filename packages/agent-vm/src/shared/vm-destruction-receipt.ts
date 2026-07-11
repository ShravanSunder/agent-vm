import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { VmDestroyReceiptV1, VmDestroyTargetV1 } from '@agent-vm/gondolin-adapter';

export class VmDestructionUnprovenError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'VmDestructionUnprovenError';
	}
}

export class IncompleteVmDestructionError extends VmDestructionUnprovenError {
	readonly receipt: VmDestroyReceiptV1;

	constructor(context: string, receipt: VmDestroyReceiptV1) {
		super(`${context} returned an incomplete exact VM destruction receipt`);
		this.name = 'IncompleteVmDestructionError';
		this.receipt = receipt;
	}
}

export class VmDestructionReceiptMismatchError extends VmDestructionUnprovenError {
	constructor(context: string) {
		super(`${context} returned a destruction receipt for a different VM target`);
		this.name = 'VmDestructionReceiptMismatchError';
	}
}

export function assertVmDestructionComplete(receipt: VmDestroyReceiptV1, context: string): void {
	if (!receipt.complete) {
		throw new IncompleteVmDestructionError(context, receipt);
	}
}

function receiptExecutableName(executablePath: string): string {
	const executableName = path.basename(executablePath);
	return /^[A-Za-z0-9._+-]{1,128}$/u.test(executableName) ? executableName : 'runner';
}

export function vmDestroyReceiptMatchesTarget(
	receipt: VmDestroyReceiptV1,
	target: VmDestroyTargetV1,
): boolean {
	const expectedRunner = {
		backend: target.runner.backend,
		discoveryIdentity: target.runner.discoveryIdentity,
		executableName: receiptExecutableName(target.runner.executable),
		...(target.runner.pid === undefined ? {} : { pid: target.runner.pid }),
		...(target.runner.startCookie === undefined ? {} : { startCookie: target.runner.startCookie }),
	};
	return (
		receipt.complete &&
		receipt.contractVersion === target.contractVersion &&
		receipt.controllerEpoch === target.controllerEpoch &&
		isDeepStrictEqual(receipt.parentGateway, target.parentGateway) &&
		receipt.reservationId === target.reservationId &&
		receipt.role === target.role &&
		receipt.vmId === target.vmId &&
		isDeepStrictEqual(receipt.requestedRunner, expectedRunner)
	);
}

export function assertVmDestroyReceiptMatchesTarget(
	receipt: VmDestroyReceiptV1,
	target: VmDestroyTargetV1,
	context: string,
): void {
	if (!vmDestroyReceiptMatchesTarget(receipt, target)) {
		throw new VmDestructionReceiptMismatchError(context);
	}
}

export function containsIncompleteVmDestructionError(error: unknown): boolean {
	return findVmDestructionError(error) instanceof IncompleteVmDestructionError;
}

export function containsUnprovenVmDestructionError(error: unknown): boolean {
	return findVmDestructionError(error) !== undefined;
}

function findVmDestructionError(error: unknown): VmDestructionUnprovenError | undefined {
	const pendingErrors: unknown[] = [error];
	const visitedErrors = new Set<unknown>();
	while (pendingErrors.length > 0) {
		const currentError = pendingErrors.pop();
		if (visitedErrors.has(currentError)) {
			continue;
		}
		visitedErrors.add(currentError);
		if (currentError instanceof VmDestructionUnprovenError) {
			return currentError;
		}
		if (currentError instanceof AggregateError) {
			pendingErrors.push(...currentError.errors);
		}
		if (currentError instanceof Error && currentError.cause !== undefined) {
			pendingErrors.push(currentError.cause);
		}
	}
	return undefined;
}
