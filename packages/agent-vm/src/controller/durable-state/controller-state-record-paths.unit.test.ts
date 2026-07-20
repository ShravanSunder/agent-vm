import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	createControllerStateRoot,
	type ControllerGatewayStateRoot,
	resolveControllerGatewayStateRoot,
} from './controller-state-paths.js';
import {
	resolveControllerGatewayRecordTargets,
	resolveControllerWorkerTaskRuntimeRecordTarget,
} from './controller-state-record-paths.js';

function createGatewayStateRoot(): ControllerGatewayStateRoot {
	const controllerStateRoot = createControllerStateRoot({
		controllerStateDirectoryPath: path.join(path.sep, 'srv', 'agent-vm', 'controller-state'),
	});
	return resolveControllerGatewayStateRoot({ controllerStateRoot, zoneId: 'zone-a' });
}

describe('controller state record paths', () => {
	it('derives immutable approval, managed Gateway, Tool lease, and Worker task roots', () => {
		// Arrange
		const gatewayStateRoot = createGatewayStateRoot();

		// Act
		const targets = resolveControllerGatewayRecordTargets({ gatewayStateRoot });

		// Assert
		expect(targets).toEqual({
			approvalRecords: {
				directoryPath: path.join(gatewayStateRoot.directoryPath, 'approvals'),
				kind: 'controller-approval-records',
				zoneId: 'zone-a',
			},
			managedGatewayRuntimeRecord: {
				filePath: path.join(gatewayStateRoot.directoryPath, 'gateway-runtime.json'),
				kind: 'controller-managed-gateway-runtime-record',
				zoneId: 'zone-a',
			},
			toolLeaseRecords: {
				directoryPath: path.join(gatewayStateRoot.directoryPath, 'tool-leases'),
				kind: 'controller-tool-lease-records',
				zoneId: 'zone-a',
			},
			workerTaskRecords: {
				directoryPath: path.join(gatewayStateRoot.directoryPath, 'worker-tasks'),
				kind: 'controller-worker-task-records',
				zoneId: 'zone-a',
			},
		});
		expect(Object.isFrozen(targets)).toBe(true);
		expect(Object.values(targets).every((target) => Object.isFrozen(target))).toBe(true);
	});

	it('derives one immutable Worker runtime record beneath its controller-owned task child', () => {
		// Arrange
		const gatewayStateRoot = createGatewayStateRoot();

		// Act
		const target = resolveControllerWorkerTaskRuntimeRecordTarget({
			gatewayStateRoot,
			taskId: 'task-123',
		});

		// Assert
		expect(target).toEqual({
			filePath: path.join(
				gatewayStateRoot.directoryPath,
				'worker-tasks',
				'task-123',
				'gateway-runtime.json',
			),
			kind: 'controller-worker-task-runtime-record',
			taskId: 'task-123',
			zoneId: 'zone-a',
		});
		expect(Object.isFrozen(target)).toBe(true);
	});

	it.each(['', '.', '..', '../escape', 'nested/task', String.raw`nested\task`, 'nul\0task'])(
		'rejects unsafe Worker task id %j before deriving a child path',
		(unsafeTaskId) => {
			// Arrange
			const gatewayStateRoot = createGatewayStateRoot();

			// Act / Assert
			expect(() =>
				resolveControllerWorkerTaskRuntimeRecordTarget({
					gatewayStateRoot,
					taskId: unsafeTaskId,
				}),
			).toThrow(/Worker task id must be one safe path segment/u);
		},
	);
});
