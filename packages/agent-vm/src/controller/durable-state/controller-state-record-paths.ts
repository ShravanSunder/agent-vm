import path from 'node:path';

import type { ControllerGatewayStateRoot } from './controller-state-paths.js';

export interface ControllerApprovalRecordsTarget {
	readonly directoryPath: string;
	readonly kind: 'controller-approval-records';
	readonly zoneId: string;
}

export interface ControllerManagedGatewayRuntimeRecordTarget {
	readonly filePath: string;
	readonly kind: 'controller-managed-gateway-runtime-record';
	readonly zoneId: string;
}

export interface ControllerToolLeaseRecordsTarget {
	readonly directoryPath: string;
	readonly kind: 'controller-tool-lease-records';
	readonly zoneId: string;
}

export interface ControllerWorkerTaskRecordsTarget {
	readonly directoryPath: string;
	readonly kind: 'controller-worker-task-records';
	readonly zoneId: string;
}

export interface ControllerWorkerTaskRuntimeRecordTarget {
	readonly filePath: string;
	readonly kind: 'controller-worker-task-runtime-record';
	readonly taskId: string;
	readonly zoneId: string;
}

export interface ControllerGatewayRecordTargets {
	readonly approvalRecords: ControllerApprovalRecordsTarget;
	readonly managedGatewayRuntimeRecord: ControllerManagedGatewayRuntimeRecordTarget;
	readonly toolLeaseRecords: ControllerToolLeaseRecordsTarget;
	readonly workerTaskRecords: ControllerWorkerTaskRecordsTarget;
}

const gatewayRuntimeRecordFileName = 'gateway-runtime.json';
const workerTaskRecordsDirectoryName = 'worker-tasks';

function assertSafeWorkerTaskId(taskId: string): void {
	if (
		taskId.length === 0 ||
		taskId === '.' ||
		taskId === '..' ||
		taskId.includes('/') ||
		taskId.includes('\\') ||
		taskId.includes('\0')
	) {
		throw new Error('Worker task id must be one safe path segment.');
	}
}

export function resolveControllerGatewayRecordTargets(options: {
	readonly gatewayStateRoot: ControllerGatewayStateRoot;
}): ControllerGatewayRecordTargets {
	const approvalRecords = Object.freeze({
		directoryPath: path.join(options.gatewayStateRoot.directoryPath, 'approvals'),
		kind: 'controller-approval-records',
		zoneId: options.gatewayStateRoot.zoneId,
	}) satisfies ControllerApprovalRecordsTarget;
	const managedGatewayRuntimeRecord = Object.freeze({
		filePath: path.join(options.gatewayStateRoot.directoryPath, gatewayRuntimeRecordFileName),
		kind: 'controller-managed-gateway-runtime-record',
		zoneId: options.gatewayStateRoot.zoneId,
	}) satisfies ControllerManagedGatewayRuntimeRecordTarget;
	const toolLeaseRecords = Object.freeze({
		directoryPath: path.join(options.gatewayStateRoot.directoryPath, 'tool-leases'),
		kind: 'controller-tool-lease-records',
		zoneId: options.gatewayStateRoot.zoneId,
	}) satisfies ControllerToolLeaseRecordsTarget;
	const workerTaskRecords = Object.freeze({
		directoryPath: path.join(
			options.gatewayStateRoot.directoryPath,
			workerTaskRecordsDirectoryName,
		),
		kind: 'controller-worker-task-records',
		zoneId: options.gatewayStateRoot.zoneId,
	}) satisfies ControllerWorkerTaskRecordsTarget;

	return Object.freeze({
		approvalRecords,
		managedGatewayRuntimeRecord,
		toolLeaseRecords,
		workerTaskRecords,
	});
}

export function resolveControllerWorkerTaskRuntimeRecordTarget(options: {
	readonly gatewayStateRoot: ControllerGatewayStateRoot;
	readonly taskId: string;
}): ControllerWorkerTaskRuntimeRecordTarget {
	assertSafeWorkerTaskId(options.taskId);
	return Object.freeze({
		filePath: path.join(
			options.gatewayStateRoot.directoryPath,
			workerTaskRecordsDirectoryName,
			options.taskId,
			gatewayRuntimeRecordFileName,
		),
		kind: 'controller-worker-task-runtime-record',
		taskId: options.taskId,
		zoneId: options.gatewayStateRoot.zoneId,
	});
}
