import { expect, it } from 'vitest';

import { createAuthProofBarrierServer } from '#auth/test-fixtures/auth-proof-barrier-server';

it('drives a held management event through direct Node controls and releases the invocation afterward', async () => {
	const barrier = createAuthProofBarrierServer();
	try {
		const controls = barrier.managementHolds;
		const requestId = 'owner-operation';
		expect(await controls.managementHoldStatus(requestId)).toEqual({
			armed: false,
			observed: false,
		});
		await controls.armManagementHold(requestId);
		const entered = controls.enteredManagementHold(requestId);
		let invocationReleased = false;
		const event = { point: 'before-provider-owner-read', requestId };
		const invocation = barrier
			.handle(
				`/__auth-proof/management-hold/arrive?key=${requestId}`,
				'POST',
				JSON.stringify(event),
			)
			.then((response) => {
				invocationReleased = true;
				return response;
			});
		expect(await entered).toEqual(event);
		expect(await controls.managementHoldStatus(requestId)).toEqual({ armed: true, observed: true });
		expect(invocationReleased).toBe(false);
		await controls.releaseManagementHold(requestId);
		expect((await invocation)?.status).toBe(204);
		expect(invocationReleased).toBe(true);
		expect(await controls.managementHoldStatus(requestId)).toEqual({
			armed: false,
			observed: false,
		});
	} finally {
		barrier.close();
	}
});

it('does not hold an invocation when no Node control armed its operation', async () => {
	const barrier = createAuthProofBarrierServer();
	try {
		const response = await barrier.handle(
			'/__auth-proof/management-hold/arrive?key=unarmed',
			'POST',
			'{}',
		);
		expect(response?.status).toBe(204);
		expect(await barrier.managementHolds.managementHoldStatus('unarmed')).toEqual({
			armed: false,
			observed: false,
		});
	} finally {
		barrier.close();
	}
});
