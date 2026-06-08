import { controllerRequestPolicies } from '@agent-vm/gateway-interface';
import { describe, expect, it, vi } from 'vitest';

import {
	fetchWorkerControllerWithPolicy,
	type WorkerControllerRequestPolicyTransportError,
} from './controller-request-policy.js';

describe('worker controller request policy', () => {
	it('passes an AbortSignal to fetch and uses the shared long timeout for worker git pushes', async () => {
		vi.useFakeTimers();
		try {
			let capturedSignal: AbortSignal | undefined;
			const fetchImpl = vi.fn(
				async (_input: string | URL | Request, init?: RequestInit) =>
					await new Promise<Response>((_resolve, reject) => {
						capturedSignal = init?.signal ?? undefined;
						init?.signal?.addEventListener('abort', () => {
							reject(new Error('aborted by test signal'));
						});
					}),
			);

			const request = fetchWorkerControllerWithPolicy({
				fetchImpl,
				input: 'http://controller.vm.host:18800/zones/zone-1/tasks/task-1/push-branches',
				init: { method: 'POST' },
				operation: 'worker-push-branches',
			});
			const rejection = expect(request).rejects.toMatchObject({
				code: 'controller-request-timeout',
				operation: 'worker-push-branches',
			} satisfies Partial<WorkerControllerRequestPolicyTransportError>);

			await vi.advanceTimersByTimeAsync(
				controllerRequestPolicies['worker-push-branches'].timeoutMs - 1,
			);
			expect(capturedSignal?.aborted).toBe(false);

			await vi.advanceTimersByTimeAsync(1);

			await rejection;
			expect(capturedSignal?.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not retry worker git mutations after retryable HTTP statuses', async () => {
		const fetchImpl = vi.fn(async () => new Response('controller busy', { status: 503 }));

		const response = await fetchWorkerControllerWithPolicy({
			fetchImpl,
			input: 'http://controller.vm.host:18800/zones/zone-1/tasks/task-1/pull-default',
			init: { method: 'POST' },
			operation: 'worker-pull-default',
		});

		expect(response.status).toBe(503);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});
