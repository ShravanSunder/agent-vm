import { describe, expect, it } from 'vitest';

import { PortalCallItemResultSchema, PortalCallResultSchema } from './portal-call-result-schema.js';

const artifact = {
	byteLength: 3,
	expiresAt: '2099-01-01T00:00:00.000Z',
	fingerprint: `sha256:${'a'.repeat(64)}`,
	id: 'completed-output',
};

function deliveryFailure(): Record<string, unknown> {
	return {
		artifacts: [artifact],
		error: { code: 'execution_failed', message: 'One output could not be delivered.' },
		id: 'download',
		operationId: 'operation-1',
		outcome: {
			certainty: 'proven',
			completion: 'failed',
			kind: 'completed',
			retryClass: 'forbidden',
		},
		owningGeneration: 'generation-1',
		status: 'error',
		value: { delivery: 'partial', remoteExecution: { exitCode: 0 } },
	};
}

describe('Portal completed file-delivery failures', () => {
	it('retains complete sibling references and remote outcome without reporting aggregate success', () => {
		const item = deliveryFailure();
		expect(PortalCallItemResultSchema.parse(item)).toEqual(item);
		expect(PortalCallResultSchema.parse({ items: [item], ok: false }).ok).toBe(false);
		expect(PortalCallResultSchema.safeParse({ items: [item], ok: true }).success).toBe(false);
	});

	it.each([
		{ certainty: 'proven', kind: 'not-dispatched', retryClass: 'safe-before-dispatch' },
		{
			certainty: 'side-effects-and-termination-unknown',
			kind: 'ambiguous',
			retryClass: 'forbidden',
		},
		{ certainty: 'proven-terminated', kind: 'cancelled-proven', retryClass: 'manual-only' },
		{ certainty: 'proven', completion: 'failed', kind: 'completed', retryClass: 'policy-gated' },
	])('rejects complete-file payloads with unproven or retryable execution (%#)', (outcome) => {
		expect(PortalCallItemResultSchema.safeParse({ ...deliveryFailure(), outcome }).success).toBe(
			false,
		);
	});

	it('requires the bounded outcome value when an error carries completed artifacts', () => {
		const { value: _value, ...withoutValue } = deliveryFailure();
		expect(PortalCallItemResultSchema.safeParse(withoutValue).success).toBe(false);
	});
});
