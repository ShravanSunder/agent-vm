import { describe, expect, it, vi } from 'vitest';

import type { HeartbeatHandle, HeartbeatSenderProps } from './heartbeat-sender.js';
import { RequestHeartbeatRegistry } from './request-heartbeat-registry.js';

describe('RequestHeartbeatRegistry', () => {
	it('reference-counts acquires for the same task and caller URL', () => {
		const stop = vi.fn();
		const startHeartbeatSender = vi.fn(
			(_requestTaskId: string, _props: HeartbeatSenderProps): HeartbeatHandle => ({ stop }),
		);
		const registry = new RequestHeartbeatRegistry({ startHeartbeatSender });

		registry.acquire('task-1', 'http://caller:3000');
		registry.acquire('task-1', 'http://caller:3000');
		registry.release('task-1');
		registry.release('task-1');

		expect(startHeartbeatSender).toHaveBeenCalledTimes(1);
		expect(startHeartbeatSender).toHaveBeenCalledWith('task-1', {
			callerUrl: 'http://caller:3000',
		});
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it('rejects acquiring an active heartbeat from a different caller URL', () => {
		const registry = new RequestHeartbeatRegistry({
			startHeartbeatSender: () => ({ stop: vi.fn() }),
		});

		registry.acquire('task-1', 'http://caller-a:3000');

		expect(() => registry.acquire('task-1', 'http://caller-b:3000')).toThrow(
			"Heartbeat for request task 'task-1' is already bound to 'http://caller-a:3000'",
		);
	});

	it('warns when releasing an unknown task heartbeat', () => {
		const logWarning = vi.fn();
		const registry = new RequestHeartbeatRegistry({ logWarning });

		registry.release('missing-task');

		expect(logWarning).toHaveBeenCalledWith(
			"release called for unknown request task 'missing-task'",
		);
	});

	it('stops every active heartbeat and clears the registry on stopAll', () => {
		const firstStop = vi.fn();
		const secondStop = vi.fn();
		const startHeartbeatSender = vi
			.fn<(requestTaskId: string, props: HeartbeatSenderProps) => HeartbeatHandle>()
			.mockReturnValueOnce({ stop: firstStop })
			.mockReturnValueOnce({ stop: secondStop });
		const registry = new RequestHeartbeatRegistry({ logWarning: vi.fn(), startHeartbeatSender });

		registry.acquire('task-1', 'http://caller:3000');
		registry.acquire('task-2', 'http://caller:3000');
		registry.stopAll();
		registry.release('task-1');

		expect(firstStop).toHaveBeenCalledTimes(1);
		expect(secondStop).toHaveBeenCalledTimes(1);
		expect(startHeartbeatSender).toHaveBeenCalledTimes(2);
	});
});
