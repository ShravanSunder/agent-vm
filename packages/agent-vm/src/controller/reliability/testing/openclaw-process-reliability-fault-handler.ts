import type { OpenClawProcessSupervisorReceipt } from '../../process-supervisor/openclaw-process-supervisor-contracts.js';
import type {
	OpenClawProcessReliabilityFaultTargetRegistry,
	OpenClawProcessReliabilityFaultTargetSnapshot,
	ReliabilityFaultGenerationFence,
} from './openclaw-process-reliability-fault-target-registry.js';
import type { ReliabilityFaultHandler } from './reliability-fault-port.js';
import {
	RELIABILITY_FAULT_MAX_RESTORATION_MS,
	reliabilityFaultReceiptSchema,
	type ReliabilityFaultApplyRequest,
	type ReliabilityFaultReceipt,
	type ReliabilityFaultRefusalReason,
} from './reliability-test-fault-contracts.js';

function generationFencesEqual(
	left: ReliabilityFaultGenerationFence,
	right: ReliabilityFaultGenerationFence,
): boolean {
	return left.generation === right.generation && left.id === right.id;
}

function refusalReasonForRequest(options: {
	readonly request: ReliabilityFaultApplyRequest;
	readonly snapshot: OpenClawProcessReliabilityFaultTargetSnapshot | undefined;
}): ReliabilityFaultRefusalReason | undefined {
	if (options.request.action !== 'terminate-owned-gateway-service') {
		return 'unsupported-action';
	}
	if (options.snapshot === undefined) {
		return 'target-unavailable';
	}
	if (
		!generationFencesEqual(options.request.fences.controller, options.snapshot.controllerGeneration)
	) {
		return 'stale-controller-generation';
	}
	if (!generationFencesEqual(options.request.fences.gateway, options.snapshot.gatewayGeneration)) {
		return 'stale-gateway-generation';
	}
	if (
		!generationFencesEqual(
			options.request.fences.openClawProcess,
			options.snapshot.openClawProcessGeneration,
		)
	) {
		return 'stale-openclaw-process-generation';
	}
	if (!generationFencesEqual(options.request.target, options.snapshot.target)) {
		return 'stale-target-generation';
	}
	return undefined;
}

function receiptBase(
	request: ReliabilityFaultApplyRequest,
	receiptId: string,
	recordedAtMs: number,
): Pick<
	ReliabilityFaultReceipt,
	| 'action'
	| 'actionId'
	| 'authorityId'
	| 'fences'
	| 'receiptId'
	| 'recordedAtMs'
	| 'runId'
	| 'schemaVersion'
	| 'target'
> {
	return {
		action: request.action,
		actionId: request.actionId,
		authorityId: request.authorityId,
		fences: request.fences,
		receiptId,
		recordedAtMs,
		runId: request.runId,
		schemaVersion: 1,
		target: request.target,
	};
}

function terminationReceiptMatchesSnapshot(options: {
	readonly receipt: OpenClawProcessSupervisorReceipt;
	readonly snapshot: OpenClawProcessReliabilityFaultTargetSnapshot;
}): boolean {
	return (
		options.receipt.kind === 'terminate-for-reliability-test' &&
		options.receipt.status === 'completed' &&
		options.receipt.expectedProcessEpoch === options.snapshot.processEpoch &&
		options.receipt.observedProcessEpoch === options.snapshot.processEpoch &&
		!options.receipt.cgroup.populated &&
		'emptyObserved' in options.receipt.cgroup &&
		options.receipt.cgroup.emptyObserved &&
		options.receipt.gateway.controllerEpoch === options.snapshot.gateway.controllerEpoch &&
		options.receipt.gateway.gatewayEpochId === options.snapshot.gateway.gatewayEpochId &&
		options.receipt.gateway.gatewayVmId === options.snapshot.gateway.gatewayVmId
	);
}

export function createOpenClawProcessReliabilityFaultHandler(options: {
	readonly createReceiptId: () => string;
	readonly nowMs: () => number;
	readonly registry: OpenClawProcessReliabilityFaultTargetRegistry;
}): ReliabilityFaultHandler {
	return async (request): Promise<ReliabilityFaultReceipt> => {
		const recordedAtMs = options.nowMs();
		const receiptId = options.createReceiptId();
		const snapshot = options.registry.getCurrent(request.target);
		const refusalReason = refusalReasonForRequest({ request, snapshot });
		if (refusalReason !== undefined || snapshot === undefined) {
			return reliabilityFaultReceiptSchema.parse({
				...receiptBase(request, receiptId, recordedAtMs),
				reason: refusalReason ?? 'target-unavailable',
				state: 'refused',
			});
		}
		let terminationReceipt: OpenClawProcessSupervisorReceipt;
		try {
			terminationReceipt = await snapshot.reliabilityFaultActuator.terminateOwnedProcess({
				actionId: request.actionId,
				expectedProcessEpoch: snapshot.processEpoch,
			});
		} catch {
			return reliabilityFaultReceiptSchema.parse({
				...receiptBase(request, receiptId, recordedAtMs),
				failurePhase: 'apply',
				reason: 'action-failed',
				state: 'failed',
			});
		}
		if (!options.registry.isCurrent(snapshot)) {
			return reliabilityFaultReceiptSchema.parse({
				...receiptBase(request, receiptId, recordedAtMs),
				failurePhase: 'apply',
				reason: 'target-disappeared',
				state: 'failed',
			});
		}
		if (!terminationReceiptMatchesSnapshot({ receipt: terminationReceipt, snapshot })) {
			return reliabilityFaultReceiptSchema.parse({
				...receiptBase(request, receiptId, recordedAtMs),
				failurePhase: 'apply',
				reason: 'action-failed',
				state: 'failed',
			});
		}
		return reliabilityFaultReceiptSchema.parse({
			...receiptBase(request, receiptId, recordedAtMs),
			restorationDeadlineMs:
				recordedAtMs + RELIABILITY_FAULT_MAX_RESTORATION_MS['terminate-owned-gateway-service'],
			state: 'applied',
		});
	};
}
