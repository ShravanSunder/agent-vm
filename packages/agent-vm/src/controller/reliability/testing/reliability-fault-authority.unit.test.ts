import { describe, expect, it } from 'vitest';

import { ReliabilityFaultAuthority } from './reliability-fault-authority.js';

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
	},
	issuedAtMs: 1_000,
	nonce: 'L9g15AipZmeLzG1IR6pB3w',
	runId: 'reliability-run-a',
	schemaVersion: 1,
	target: { generation: 11, id: 'session-a', kind: 'control-session' },
} as const;

describe('ReliabilityFaultAuthority', () => {
	it('admits one exact-run request once and denies nonce/action replay', () => {
		const authority = new ReliabilityFaultAuthority({
			authorityId: request.authorityId,
			nowMs: () => 1_500,
			runId: request.runId,
		});

		expect(authority.authorize(request)).toEqual({ ok: true });
		expect(authority.authorize(request)).toEqual({ ok: false, reason: 'replayed-request' });
		expect(
			authority.authorize({
				...request,
				actionId: 'a8fba2b8-349c-44cf-95da-ad87cf928596',
			}),
		).toEqual({ ok: false, reason: 'replayed-request' });
	});

	it('denies wrong authority, wrong run, and expired requests with typed reasons', () => {
		const authority = new ReliabilityFaultAuthority({
			authorityId: request.authorityId,
			nowMs: () => 2_001,
			runId: request.runId,
		});

		expect(
			authority.authorize({
				...request,
				authorityId: '57c3a575-303d-45b0-9b6e-1ea6d867bce2',
			}),
		).toEqual({ ok: false, reason: 'invalid-authority' });
		expect(authority.authorize({ ...request, runId: 'another-run' })).toEqual({
			ok: false,
			reason: 'wrong-run',
		});
		expect(authority.authorize(request)).toEqual({ ok: false, reason: 'expired-request' });
	});
});
