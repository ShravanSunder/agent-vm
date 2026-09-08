import path from 'node:path';

import type { ControllerGatewayStateRoot } from './controller-state-paths.js';

export interface ControllerApprovalRecordsTarget {
	readonly directoryPath: string;
	readonly kind: 'controller-approval-records';
	readonly zoneId: string;
}

export interface ControllerCredentialedRuntimeRecordsTarget {
	readonly directoryPath: string;
	readonly kind: 'controller-credentialed-runtime-records';
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

export interface ControllerGatewayRecordTargets {
	readonly approvalRecords: ControllerApprovalRecordsTarget;
	readonly credentialedRuntimeRecords: ControllerCredentialedRuntimeRecordsTarget;
	readonly managedGatewayRuntimeRecord: ControllerManagedGatewayRuntimeRecordTarget;
	readonly toolLeaseRecords: ControllerToolLeaseRecordsTarget;
}

const gatewayRuntimeRecordFileName = 'gateway-runtime.json';

export function resolveControllerGatewayRecordTargets(options: {
	readonly gatewayStateRoot: ControllerGatewayStateRoot;
}): ControllerGatewayRecordTargets {
	const approvalRecords = Object.freeze({
		directoryPath: path.join(options.gatewayStateRoot.directoryPath, 'approvals'),
		kind: 'controller-approval-records',
		zoneId: options.gatewayStateRoot.zoneId,
	}) satisfies ControllerApprovalRecordsTarget;
	const credentialedRuntimeRecords = Object.freeze({
		directoryPath: path.join(options.gatewayStateRoot.directoryPath, 'credentialed-runtimes'),
		kind: 'controller-credentialed-runtime-records',
		zoneId: options.gatewayStateRoot.zoneId,
	}) satisfies ControllerCredentialedRuntimeRecordsTarget;
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
	return Object.freeze({
		approvalRecords,
		credentialedRuntimeRecords,
		managedGatewayRuntimeRecord,
		toolLeaseRecords,
	});
}
