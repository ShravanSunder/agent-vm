import {
	createControllerStateRoot,
	resolveControllerGatewayStateRoot,
} from '../durable-state/controller-state-paths.js';
import { resolveControllerGatewayRecordTargets } from '../durable-state/controller-state-record-paths.js';
import type { CredentialedRuntimeOwnerIdentity } from './credentialed-runtime-manager.js';
import {
	createCredentialedRuntimeRecordStore,
	type CredentialedRuntimeRecordStore,
	type CredentialedRuntimeRecord,
	type CredentialedRuntimeRecordStaticFields,
} from './credentialed-runtime-record.js';
import type { CredentialedRuntimeResolution } from './credentialed-runtime-registry.js';

export interface RuntimeRecordContext {
	readonly ownerIdentity: CredentialedRuntimeOwnerIdentity;
	readonly recordId: string;
	readonly resolution: CredentialedRuntimeResolution;
}

export interface CredentialedRuntimeRecordWriter {
	delete(zoneId: string, recordId: string): Promise<void>;
	recordsDirectoryPath(zoneId: string): string;
	write(
		context: RuntimeRecordContext,
		build: (base: {
			readonly common: CredentialedRuntimeRecordStaticFields;
			readonly generation: number;
		}) => CredentialedRuntimeRecord,
	): Promise<void>;
}

export function createCredentialedRuntimeRecordWriter(options: {
	readonly controllerStateDir: string;
}): CredentialedRuntimeRecordWriter {
	const controllerStateRoot = createControllerStateRoot({
		controllerStateDirectoryPath: options.controllerStateDir,
	});
	const recordsDirectoryPath = (zoneId: string): string =>
		resolveControllerGatewayRecordTargets({
			gatewayStateRoot: resolveControllerGatewayStateRoot({ controllerStateRoot, zoneId }),
		}).credentialedRuntimeRecords.directoryPath;
	const recordStoreForZone = (zoneId: string): CredentialedRuntimeRecordStore =>
		createCredentialedRuntimeRecordStore({ recordsDirectoryPath: recordsDirectoryPath(zoneId) });
	return {
		delete: async (zoneId, recordId): Promise<void> => {
			await recordStoreForZone(zoneId).mutateRecord(recordId, () => ({
				nextRecord: null,
				result: undefined,
			}));
		},
		recordsDirectoryPath,
		write: async (context, build): Promise<void> => {
			await recordStoreForZone(context.resolution.zoneId).mutateRecord(
				context.recordId,
				(current) => {
					const generation = (current?.generation ?? -1) + 1;
					const common: CredentialedRuntimeRecordStaticFields = {
						agentId: context.resolution.agentId,
						controllerEpoch: context.ownerIdentity.controllerEpoch,
						gatewayEpoch: context.ownerIdentity.gatewayEpoch,
						agentRuntimeRevision: context.resolution.agentRuntimeRevision,
						parentGatewayVmId: context.ownerIdentity.parentGatewayVmId,
						recordId: context.recordId,
						recordVersion: 2,
						runtimeEpoch: context.ownerIdentity.runtimeEpoch,
						stablePrincipal: context.ownerIdentity.stablePrincipal,
						zoneId: context.resolution.zoneId,
					};
					return { nextRecord: build({ common, generation }), result: undefined };
				},
			);
		},
	};
}
