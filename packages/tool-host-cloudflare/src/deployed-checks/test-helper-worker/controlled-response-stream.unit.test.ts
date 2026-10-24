import { expect, it } from 'vitest';

import { controlledResponseStream } from '#worker-host/deployed-checks/test-helper-worker/controlled-response-stream';
import type { ObservationPort } from '#worker-host/deployed-checks/test-helper-worker/models/helper-contracts';
import { emptyObservations } from '#worker-host/deployed-checks/test-helper-worker/observation-counters';

function observationPort(): { readonly port: ObservationPort; readonly finishes: string[] } {
	const finishes: string[] = [];
	return {
		finishes,
		port: {
			begin: async (): Promise<void> => {},
			finish: async (callId): Promise<void> => {
				finishes.push(callId);
			},
			snapshot: async () => emptyObservations('unit'),
			reset: async (): Promise<void> => {},
			hold: async (): Promise<void> => {},
			release: async (): Promise<void> => {},
		},
	};
}
it('streams a valid escaped result and completes its in-flight observation only on consumption', async () => {
	const { port, finishes } = observationPort();
	const response = controlledResponseStream({
		rpcId: 'unit',
		input: { runId: 'unit', callId: 'one', responseBytes: 0, value: 'quote"工具', hold: false },
		observations: port,
	});
	expect(finishes).toEqual([]);
	expect(await response.json()).toEqual({
		jsonrpc: '2.0',
		id: 'unit',
		result: { content: [{ type: 'text', text: 'quote"工具' }] },
	});
	expect(finishes).toEqual(['one']);
});
it('bounds each large chunk and finishes exactly once if the caller cancels', async () => {
	const { port, finishes } = observationPort();
	const response = controlledResponseStream({
		rpcId: 'unit',
		input: { runId: 'unit', callId: 'one', responseBytes: 4 * 1024 * 1024, value: '', hold: false },
		observations: port,
	});
	const reader = response.body?.getReader();
	if (reader === undefined) throw new Error('Missing fixture stream.');
	await reader.read();
	expect((await reader.read()).value?.byteLength).toBe(64 * 1024);
	expect(finishes).toEqual([]);
	await reader.cancel();
	expect(finishes).toEqual(['one']);
});
