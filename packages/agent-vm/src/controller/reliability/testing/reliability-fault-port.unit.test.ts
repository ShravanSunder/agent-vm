import { describe, expect, it, vi } from 'vitest';

import { createReliabilityFaultPort } from './reliability-fault-port.js';
import type {
	ReliabilityFaultApplyRequest,
	ReliabilityFaultReceipt,
	ReliabilityFaultRefusalReason,
} from './reliability-test-fault-contracts.js';

const request = {
	action: 'disconnect-control-transport',
	actionId: '0d3e8dc2-8d6b-4e63-8d1d-8c10a159d8af',
	authorityId: 'f5867f86-f1bc-4d60-967c-985686db5528',
	expiresAtMs: 2_000,
	fences: {
		controller: { generation: 7, id: 'controller-a' },
		controlSession: { generation: 11, id: 'session-a' },
		gateway: { generation: 8, id: 'gateway-a' },
		leaseLeaf: { generation: 13, id: 'agent-a' },
		openClawProcess: { generation: 9, id: 'openclaw-a' },
	},
	issuedAtMs: 1_000,
	nonce: 'L9g15AipZmeLzG1IR6pB3w',
	runId: 'reliability-run-a',
	schemaVersion: 1,
	target: { generation: 11, id: 'session-a', kind: 'control-session' },
} satisfies ReliabilityFaultApplyRequest;

function createRefusalReceipt(
	requestToRefuse: ReliabilityFaultApplyRequest,
	reason: ReliabilityFaultRefusalReason,
): ReliabilityFaultReceipt {
	return {
		action: requestToRefuse.action,
		actionId: requestToRefuse.actionId,
		authorityId: requestToRefuse.authorityId,
		fences: requestToRefuse.fences,
		reason,
		receiptId: 'c15b991a-a006-4faf-8fc7-33d3c1d82395',
		recordedAtMs: 1_500,
		runId: requestToRefuse.runId,
		schemaVersion: 1,
		state: 'refused',
		target: requestToRefuse.target,
	};
}

describe('createReliabilityFaultPort', () => {
	it('is absent unless an explicit test-only handler set is supplied', () => {
		expect(createReliabilityFaultPort()).toBeUndefined();
	});

	it('dispatches only a closed typed action registered at construction', async () => {
		const appliedReceipt = {
			action: request.action,
			actionId: request.actionId,
			authorityId: request.authorityId,
			fences: request.fences,
			receiptId: 'd25b991a-a006-4faf-8fc7-33d3c1d82395',
			recordedAtMs: 1_500,
			restorationDeadlineMs: 2_500,
			runId: request.runId,
			schemaVersion: 1,
			state: 'applied',
			target: request.target,
		} satisfies ReliabilityFaultReceipt;
		const disconnect = vi.fn(() => Promise.resolve(appliedReceipt));
		const port = createReliabilityFaultPort({
			createRefusalReceipt,
			handlers: { 'disconnect-control-transport': disconnect },
		});
		if (port === undefined) {
			throw new Error('Expected explicit test port.');
		}

		await expect(port.apply(request)).resolves.toEqual(appliedReceipt);
		await expect(
			port.apply({
				...request,
				action: 'terminate-owned-gateway-runtime',
				target: { ...request.fences.gateway, kind: 'gateway' },
			}),
		).resolves.toMatchObject({ reason: 'unsupported-action', state: 'refused' });
		expect(disconnect).toHaveBeenCalledOnce();
	});

	it('rejects handler output outside the closed receipt schema', async () => {
		const port = createReliabilityFaultPort({
			createRefusalReceipt,
			handlers: {
				'disconnect-control-transport': () =>
					Promise.resolve({ ...createRefusalReceipt(request, 'target-unavailable'), command: 'x' }),
			},
		});
		if (port === undefined) {
			throw new Error('Expected explicit test port.');
		}

		await expect(port.apply(request)).rejects.toThrow();
	});
});
