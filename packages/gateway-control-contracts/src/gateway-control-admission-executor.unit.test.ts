import { describe, expect, it } from 'vitest';

import { createGatewayControlAdmissionExecutor } from './gateway-control-admission-executor.js';

function deferred(): {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
} {
	let resolvePromise!: () => void;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

async function waitForImmediate(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('Gateway control admission executor', () => {
	it('holds queue capacity until admitted execution completes', async () => {
		const blocked = deferred();
		const executor = createGatewayControlAdmissionExecutor<string>({
			executionLimits: { authority: 1 },
		});
		const executions: string[] = [];
		const results = Array.from(
			{ length: 8 },
			(_, index) =>
				executor.submit({
					byteLength: 1,
					execute: async () => {
						executions.push(`authority-${String(index)}`);
						await blocked.promise;
					},
					id: `authority-${String(index)}`,
					messageClass: 'authority',
					payload: `authority-${String(index)}`,
					stablePrincipal: 'principal-a',
				}).completion,
		);

		await waitForImmediate();
		expect(executions).toEqual(['authority-0']);
		expect(executor.diagnostics()).toMatchObject({
			activeByClass: { authority: 1 },
			scheduler: { authorityMessages: 8 },
		});
		expect(
			executor.submit({
				byteLength: 1,
				execute: async () => undefined,
				id: 'authority-over',
				messageClass: 'authority',
				payload: 'authority-over',
				stablePrincipal: 'principal-a',
			}).admission,
		).toEqual({ reason: 'principal_capacity', status: 'refused' });

		blocked.resolve();
		await Promise.all(results);
		expect(executor.diagnostics().scheduler.authorityMessages).toBe(0);
	});

	it('starts reserved safety work while authority execution is blocked', async () => {
		const authorityBlocked = deferred();
		const safetyBlocked = deferred();
		const executor = createGatewayControlAdmissionExecutor<string>({
			executionLimits: { authority: 1, safety: 1 },
		});
		const executions: string[] = [];
		void executor.submit({
			byteLength: 1,
			execute: async () => {
				executions.push('authority');
				await authorityBlocked.promise;
			},
			id: 'authority',
			messageClass: 'authority',
			payload: 'authority',
			stablePrincipal: 'principal-a',
		});
		void executor.submit({
			byteLength: 1,
			execute: async () => {
				executions.push('safety');
				await safetyBlocked.promise;
			},
			id: 'safety',
			messageClass: 'safety',
			payload: 'safety',
		});

		await waitForImmediate();
		expect(executions).toEqual(['safety', 'authority']);
		expect(executor.diagnostics().activeByClass).toMatchObject({ authority: 1, safety: 1 });
		authorityBlocked.resolve();
		safetyBlocked.resolve();
	});

	it('settles displaced work without executing or allocating downstream state', async () => {
		const scheduled: (() => void)[] = [];
		const executor = createGatewayControlAdmissionExecutor<string>({
			scheduleImmediate: (callback) => scheduled.push(callback),
		});
		const executions: string[] = [];
		const first = executor.submit({
			byteLength: 1,
			coalesceKey: 'lease-a',
			execute: async () => {
				executions.push('first');
			},
			id: 'first',
			messageClass: 'liveness',
			payload: 'first',
		});
		const second = executor.submit({
			byteLength: 1,
			coalesceKey: 'lease-a',
			execute: async () => {
				executions.push('second');
			},
			id: 'second',
			messageClass: 'liveness',
			payload: 'second',
		});

		expect(first.admission).toEqual({ status: 'admitted' });
		expect(second.admission).toEqual({ status: 'replaced' });
		expect(await first.completion).toEqual({ status: 'replaced' });
		expect(executions).toEqual([]);
		scheduled.shift()?.();
		expect(await second.completion).toEqual({ status: 'executed' });
		expect(executions).toEqual(['second']);
	});

	it('closes queued work and ignores an already-scheduled pump', async () => {
		const scheduled: (() => void)[] = [];
		const cancellations: string[] = [];
		const executions: string[] = [];
		const executor = createGatewayControlAdmissionExecutor<string>({
			scheduleImmediate: (callback) => scheduled.push(callback),
		});
		const first = executor.submit({
			byteLength: 1,
			execute: async () => {
				executions.push('first');
			},
			id: 'first',
			messageClass: 'safety',
			onCancel: (reason) => cancellations.push(`first:${reason}`),
			payload: 'first',
		});
		const second = executor.submit({
			byteLength: 1,
			execute: async () => {
				executions.push('second');
			},
			id: 'second',
			messageClass: 'authority',
			onCancel: (reason) => cancellations.push(`second:${reason}`),
			payload: 'second',
			stablePrincipal: 'principal-a',
		});

		executor.close('session-fenced');
		expect(await first.completion).toEqual({ reason: 'session-fenced', status: 'closed' });
		expect(await second.completion).toEqual({ reason: 'session-fenced', status: 'closed' });
		scheduled.shift()?.();
		await flushMicrotasks();
		expect(executions).toEqual([]);
		expect(cancellations).toEqual(['first:session-fenced', 'second:session-fenced']);
		expect(executor.diagnostics().scheduler).toMatchObject({
			authorityMessages: 0,
			safetyMessages: 0,
		});
		expect(
			executor.submit({
				byteLength: 1,
				execute: async () => undefined,
				id: 'after-close',
				messageClass: 'safety',
				payload: 'after-close',
			}).admission,
		).toEqual({ reason: 'session-fenced', status: 'closed' });
	});

	it('settles in-flight work on close and generation-fences late completion', async () => {
		const scheduled: (() => void)[] = [];
		const blocked = deferred();
		const cancellations: string[] = [];
		const executor = createGatewayControlAdmissionExecutor<string>({
			scheduleImmediate: (callback) => scheduled.push(callback),
		});
		let completedExecutions = 0;
		const result = executor.submit({
			byteLength: 1,
			execute: async () => {
				await blocked.promise;
				completedExecutions += 1;
			},
			id: 'in-flight',
			messageClass: 'safety',
			onCancel: (reason) => cancellations.push(reason),
			payload: 'in-flight',
		});
		scheduled.shift()?.();
		await flushMicrotasks();
		expect(executor.diagnostics().activeByClass.safety).toBe(1);

		executor.close('attachment-replaced');
		expect(await result.completion).toEqual({
			reason: 'attachment-replaced',
			status: 'closed',
		});
		expect(cancellations).toEqual(['attachment-replaced']);
		blocked.resolve();
		await flushMicrotasks();
		expect(completedExecutions).toBe(1);
		expect(executor.diagnostics()).toMatchObject({
			activeByClass: { safety: 0 },
			scheduler: { safetyMessages: 0 },
		});
	});
});
