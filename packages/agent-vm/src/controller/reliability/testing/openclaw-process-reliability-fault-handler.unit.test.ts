import { describe, expect, it, vi } from 'vitest';

import { openClawProcessSupervisorReceiptSchema } from '../../process-supervisor/openclaw-process-supervisor-contracts.js';
import type { OpenClawProcessReliabilityFaultActuator } from '../../process-supervisor/openclaw-process-supervisor.js';
import type { GatewayEpochIdentity } from '../../vm-ownership/vm-ownership-contracts.js';
import { createOpenClawProcessReliabilityFaultHandler } from './openclaw-process-reliability-fault-handler.js';
import { createOpenClawProcessReliabilityFaultTargetRegistry } from './openclaw-process-reliability-fault-target-registry.js';
import type { ReliabilityFaultApplyRequest } from './reliability-test-fault-contracts.js';

const CONTROLLER_GENERATION = { generation: 7, id: 'controller-epoch-1' } as const;
const GATEWAY = {
	bootId: 'gateway-boot-1',
	controllerEpoch: CONTROLLER_GENERATION.id,
	gatewayEpochId: 'gateway-epoch-1',
	gatewayVmId: 'gateway-vm-1',
	generationId: 'gateway-generation-1',
	zoneId: 'shravan',
} satisfies GatewayEpochIdentity;

const ACTION_ID = '0d3e8dc2-8d6b-4e63-8d1d-8c10a159d8af';
const AUTHORITY_ID = 'f5867f86-f1bc-4d60-967c-985686db5528';
const RECEIPT_ID = 'd25b991a-a006-4faf-8fc7-33d3c1d82395';

type Registry = ReturnType<typeof createOpenClawProcessReliabilityFaultTargetRegistry>;
type TargetSnapshot = ReturnType<Registry['publish']>;

function createRequest(snapshot: TargetSnapshot): ReliabilityFaultApplyRequest {
	return {
		action: 'terminate-owned-gateway-service',
		actionId: ACTION_ID,
		authorityId: AUTHORITY_ID,
		expiresAtMs: 2_000,
		fences: {
			controller: snapshot.controllerGeneration,
			controlSession: { generation: 0, id: 'unused-control-session' },
			gateway: snapshot.gatewayGeneration,
			leaseLeaf: { generation: 0, id: 'unused-lease-leaf' },
			openClawProcess: snapshot.openClawProcessGeneration,
		},
		issuedAtMs: 1_000,
		nonce: 'L9g15AipZmeLzG1IR6pB3w',
		runId: 'reliability-run-a',
		schemaVersion: 1,
		target: snapshot.target,
	};
}

function createCompletedTerminationReceipt(
	processEpoch: string,
): ReturnType<typeof openClawProcessSupervisorReceiptSchema.parse> {
	return openClawProcessSupervisorReceiptSchema.parse({
		actionId: ACTION_ID,
		cgroup: {
			emptyObserved: true,
			name: `agent-vm-${processEpoch}`,
			populated: false,
		},
		contractVersion: 1,
		expectedProcessEpoch: processEpoch,
		gateway: {
			controllerEpoch: GATEWAY.controllerEpoch,
			gatewayEpochId: GATEWAY.gatewayEpochId,
			gatewayVmId: GATEWAY.gatewayVmId,
		},
		kind: 'terminate-for-reliability-test',
		observedProcessEpoch: processEpoch,
		status: 'completed',
	});
}

function createHarness(actuator: OpenClawProcessReliabilityFaultActuator): {
	readonly handler: ReturnType<typeof createOpenClawProcessReliabilityFaultHandler>;
	readonly registry: Registry;
	readonly snapshot: TargetSnapshot;
} {
	const registry = createOpenClawProcessReliabilityFaultTargetRegistry({
		controllerGeneration: CONTROLLER_GENERATION,
	});
	const snapshot = registry.publish({
		gateway: GATEWAY,
		processEpoch: 'process-1',
		reliabilityFaultActuator: actuator,
	});
	return {
		handler: createOpenClawProcessReliabilityFaultHandler({
			createReceiptId: () => RECEIPT_ID,
			nowMs: () => 1_500,
			registry,
		}),
		registry,
		snapshot,
	};
}

describe('createOpenClawProcessReliabilityFaultHandler', () => {
	it('returns applied only after exact typed process termination is positively complete', async () => {
		const terminateOwnedProcess = vi.fn(async () => createCompletedTerminationReceipt('process-1'));
		const harness = createHarness({ terminateOwnedProcess });
		const request = createRequest(harness.snapshot);

		await expect(harness.handler(request)).resolves.toMatchObject({
			action: 'terminate-owned-gateway-service',
			actionId: ACTION_ID,
			receiptId: RECEIPT_ID,
			recordedAtMs: 1_500,
			state: 'applied',
			target: harness.snapshot.target,
		});
		expect(terminateOwnedProcess).toHaveBeenCalledExactlyOnceWith({
			actionId: ACTION_ID,
			expectedProcessEpoch: 'process-1',
		});
	});

	it('cannot report applied when the exact target is replaced during the actuator await', async () => {
		let resolveTermination!: (
			receipt: ReturnType<typeof createCompletedTerminationReceipt>,
		) => void;
		const termination = new Promise<ReturnType<typeof createCompletedTerminationReceipt>>(
			(resolve) => {
				resolveTermination = resolve;
			},
		);
		const terminateOwnedProcess = vi.fn(() => termination);
		const harness = createHarness({ terminateOwnedProcess });
		const request = createRequest(harness.snapshot);

		const receipt = harness.handler(request);
		await vi.waitFor(() => expect(terminateOwnedProcess).toHaveBeenCalledOnce());
		harness.registry.publish({
			gateway: GATEWAY,
			processEpoch: 'process-2',
			reliabilityFaultActuator: { terminateOwnedProcess: vi.fn() },
		});
		resolveTermination(createCompletedTerminationReceipt('process-1'));

		await expect(receipt).resolves.toMatchObject({
			failurePhase: 'apply',
			reason: 'target-disappeared',
			state: 'failed',
		});
	});

	it('returns action-failed when the typed actuator rejects', async () => {
		const terminateOwnedProcess = vi.fn(async () => {
			throw new Error('fixed helper failed');
		});
		const harness = createHarness({ terminateOwnedProcess });

		await expect(harness.handler(createRequest(harness.snapshot))).resolves.toMatchObject({
			failurePhase: 'apply',
			reason: 'action-failed',
			state: 'failed',
		});
	});
});
