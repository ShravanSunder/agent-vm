import { describe, expect, it } from 'vitest';

import {
	RELIABILITY_FAULT_ACTION_TARGET_KIND,
	RELIABILITY_FAULT_MAX_REQUEST_VALIDITY_MS,
	RELIABILITY_FAULT_MAX_RESTORATION_MS,
	reliabilityFaultApplyRequestSchema,
	reliabilityFaultReceiptSchema,
} from './reliability-test-fault-contracts.js';

const validFences = {
	controller: { generation: 7, id: 'controller-a' },
	controlSession: { generation: 11, id: 'session-a' },
	gateway: { generation: 8, id: 'gateway-a' },
	leaseLeaf: { generation: 13, id: 'agent-a' },
} as const;

const validRequest = {
	action: 'disconnect-control-transport',
	actionId: '0d3e8dc2-8d6b-4e63-8d1d-8c10a159d8af',
	authorityId: 'f5867f86-f1bc-4d60-967c-985686db5528',
	expiresAtMs: 2_000,
	fences: validFences,
	issuedAtMs: 1_000,
	nonce: 'L9g15AipZmeLzG1IR6pB3w',
	runId: 'reliability-run-a',
	schemaVersion: 1,
	target: { generation: 11, id: 'session-a', kind: 'control-session' },
} as const;

describe('reliabilityFaultApplyRequestSchema', () => {
	it('accepts a closed action with controller, control-session, Gateway, and lease fences', () => {
		expect(reliabilityFaultApplyRequestSchema.parse(validRequest)).toEqual(validRequest);
		expect(RELIABILITY_FAULT_ACTION_TARGET_KIND[validRequest.action]).toBe(
			validRequest.target.kind,
		);
	});

	it('rejects missing or mismatched generation fences', () => {
		const { leaseLeaf: _leaseLeaf, ...missingLeafFences } = validFences;
		expect(
			reliabilityFaultApplyRequestSchema.safeParse({
				...validRequest,
				fences: missingLeafFences,
			}).success,
		).toBe(false);
		expect(
			reliabilityFaultApplyRequestSchema.safeParse({
				...validRequest,
				target: { ...validRequest.target, generation: 12 },
			}).success,
		).toBe(false);
	});

	it('rejects arbitrary command, signal, path, duration, and payload controls', () => {
		for (const unsafeField of [
			{ command: 'kill -9 1' },
			{ durationMs: 60_000 },
			{ path: '/host/runtime' },
			{ payload: { arbitrary: true } },
			{ signal: 'SIGKILL' },
		]) {
			expect(
				reliabilityFaultApplyRequestSchema.safeParse({ ...validRequest, ...unsafeField }).success,
			).toBe(false);
		}
	});

	it('accepts every closed action only with its mapped target kind', () => {
		const fenceByTargetKind = {
			controller: validFences.controller,
			'control-session': validFences.controlSession,
			gateway: validFences.gateway,
			'lease-leaf': validFences.leaseLeaf,
		} as const;
		for (const [action, kind] of Object.entries(RELIABILITY_FAULT_ACTION_TARGET_KIND)) {
			expect(
				reliabilityFaultApplyRequestSchema.safeParse({
					...validRequest,
					action,
					target: { ...fenceByTargetKind[kind], kind },
				}).success,
			).toBe(true);
		}
	});

	it('rejects the retired OpenClaw process fault vocabulary', () => {
		expect(
			reliabilityFaultApplyRequestSchema.safeParse({
				...validRequest,
				fences: {
					...validFences,
					openClawProcess: { generation: 9, id: 'openclaw-a' },
				},
			}).success,
		).toBe(false);
		expect(
			reliabilityFaultApplyRequestSchema.safeParse({
				...validRequest,
				action: 'terminate-owned-gateway-service',
				target: { generation: 9, id: 'openclaw-a', kind: 'openclaw-process' },
			}).success,
		).toBe(false);
	});

	it('enforces bounded non-empty validity and nonnegative generations', () => {
		expect(
			reliabilityFaultApplyRequestSchema.safeParse({
				...validRequest,
				expiresAtMs: validRequest.issuedAtMs,
			}).success,
		).toBe(false);
		expect(
			reliabilityFaultApplyRequestSchema.safeParse({
				...validRequest,
				expiresAtMs: validRequest.issuedAtMs + RELIABILITY_FAULT_MAX_REQUEST_VALIDITY_MS + 1,
			}).success,
		).toBe(false);
		expect(
			reliabilityFaultApplyRequestSchema.safeParse({
				...validRequest,
				fences: { ...validFences, gateway: { ...validFences.gateway, generation: -1 } },
			}).success,
		).toBe(false);
	});
});

describe('reliabilityFaultReceiptSchema', () => {
	const commonReceipt = {
		action: validRequest.action,
		actionId: validRequest.actionId,
		authorityId: validRequest.authorityId,
		fences: validRequest.fences,
		recordedAtMs: 1_100,
		receiptId: 'c15b991a-a006-4faf-8fc7-33d3c1d82395',
		runId: validRequest.runId,
		schemaVersion: 1,
		target: validRequest.target,
	} as const;

	it('accepts bounded applied and typed refusal/failure receipts', () => {
		expect(
			reliabilityFaultReceiptSchema.parse({
				...commonReceipt,
				restorationDeadlineMs: 21_100,
				state: 'applied',
			}),
		).toMatchObject({ state: 'applied' });
		expect(
			reliabilityFaultReceiptSchema.parse({
				...commonReceipt,
				reason: 'replayed-request',
				state: 'refused',
			}),
		).toMatchObject({ reason: 'replayed-request', state: 'refused' });
		expect(
			reliabilityFaultReceiptSchema.parse({
				...commonReceipt,
				failurePhase: 'apply',
				reason: 'action-failed',
				state: 'failed',
			}),
		).toMatchObject({ reason: 'action-failed', state: 'failed' });
	});

	it('requires launcher terminal proof for controller exit and bounds every deadline', () => {
		const exitReceipt = {
			...commonReceipt,
			action: 'exit-controller-after-receipt',
			launcherProofDeadlineMs:
				commonReceipt.recordedAtMs +
				RELIABILITY_FAULT_MAX_RESTORATION_MS['exit-controller-after-receipt'],
			launcherTerminalProofRequired: true,
			state: 'exit-armed',
			target: { generation: 7, id: 'controller-a', kind: 'controller' },
		} as const;
		expect(reliabilityFaultReceiptSchema.parse(exitReceipt)).toEqual(exitReceipt);
		expect(
			reliabilityFaultReceiptSchema.safeParse({
				...exitReceipt,
				launcherTerminalProofRequired: false,
			}).success,
		).toBe(false);
	});

	it('rejects unsafe receipt metadata and mismatched target generation', () => {
		expect(
			reliabilityFaultReceiptSchema.safeParse({
				...commonReceipt,
				command: 'kill -9 1',
				restorationDeadlineMs: commonReceipt.recordedAtMs + 1,
				state: 'applied',
			}).success,
		).toBe(false);
		expect(
			reliabilityFaultReceiptSchema.safeParse({
				...commonReceipt,
				restorationDeadlineMs: commonReceipt.recordedAtMs + 1,
				state: 'applied',
				target: { ...commonReceipt.target, generation: 12 },
			}).success,
		).toBe(false);
		expect(
			reliabilityFaultReceiptSchema.safeParse({
				...commonReceipt,
				reason: 'stale-openclaw-process-generation',
				state: 'refused',
			}).success,
		).toBe(false);
	});
});
