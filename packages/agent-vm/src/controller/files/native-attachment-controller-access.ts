import type { PortalAttachmentResult } from '@agent-vm/agent-portal-sdk';
import type { ManagedVm } from '@agent-vm/managed-vm';

import type { GatewayControlControllerExecutionOperations } from '../control-session/gateway-control-domain-handler.js';
import {
	withCurrentToolVmWorkFiles,
	type ToolVmWorkFileLeaseManager,
} from './current-tool-vm-work-files.js';
import { createNativeAttachmentHostFiles } from './native-attachment-host-files.js';
import type {
	createNativeAttachmentStaging,
	NativeAttachmentStageResult,
} from './native-attachment-staging.js';
import {
	loadOperationFolderGuestProgram,
	type OperationFolderGuestAccess,
} from './operation-folder-guest-access.js';
import type { SharedStagingDirectoryStore } from './shared-staging-directory-store.js';

type NativeRequest = Parameters<
	NonNullable<GatewayControlControllerExecutionOperations['accessNativeAttachment']>
>[0];

/** Both VM choices come from controller state; source and destination lifetimes remain separate. */
export async function accessNativeAttachment(props: {
	readonly context: NativeRequest;
	readonly destinationVm: Pick<ManagedVm, 'id'>;
	readonly cacheDirectory: string;
	readonly sharedStaging: SharedStagingDirectoryStore;
	readonly destinationAuthorityIsCurrent: () => boolean;
	readonly leaseManager: ToolVmWorkFileLeaseManager;
	readonly staging: ReturnType<typeof createNativeAttachmentStaging>;
}): Promise<PortalAttachmentResult> {
	const { callerContext, gateway, request, sessionId, executionProof, signal } = props.context;
	const owner = {
		agentId: callerContext.agentId,
		zoneId: callerContext.zoneId,
		gatewayVmId: gateway.gatewayVmId,
		stablePrincipal: callerContext.stablePrincipal,
		profileName: callerContext.principal.frameworkIdentity.profileName,
		sessionId,
	};
	if (props.destinationVm.id !== gateway.gatewayVmId || !props.destinationAuthorityIsCurrent())
		return { kind: 'unavailable' };
	if (request.action === 'settle')
		return await props.staging.settle({
			owner,
			stagingId: request.stagingId,
			outcome: request.outcome,
		});
	const host = await createNativeAttachmentHostFiles({
		cacheDirectory: props.cacheDirectory,
		controllerEpoch: gateway.controllerEpoch,
		gatewayVmId: gateway.gatewayVmId,
		signal,
	});
	const program = await loadOperationFolderGuestProgram();
	const { destination, writer } = host;
	const stage = async (
		source: Pick<OperationFolderGuestAccess, 'read'>,
		sourceSignal: AbortSignal,
		sourceAuthorityIsCurrent: () => boolean,
	): Promise<NativeAttachmentStageResult> =>
		await props.staging.stage({
			owner,
			destinationRoot: host.guestRoot,
			source,
			sourceRelativePath: request.source.path,
			destination,
			destinationWriter: writer,
			signal: AbortSignal.any([signal, sourceSignal]),
			sourceAuthorityIsCurrent,
			destinationAuthorityIsCurrent: props.destinationAuthorityIsCurrent,
		});
	try {
		if (request.source.kind === 'tool-vm-file')
			return await withCurrentToolVmWorkFiles({
				agentId: callerContext.agentId,
				authority: { gateway, principal: callerContext.principal },
				executionProof,
				leaseManager: props.leaseManager,
				program,
				signal,
				use: async (access) => await stage(access.files, access.signal, access.authorityIsCurrent),
			});
		const sourceReference = request.source;
		return await withCurrentToolVmWorkFiles({
			agentId: callerContext.agentId,
			authority: { gateway, principal: callerContext.principal },
			executionProof,
			leaseManager: props.leaseManager,
			program,
			signal,
			use: async (access) =>
				await stage(
					{
						read: (relativePath) =>
							props.sharedStaging.readPublishedFile({
								publicationId: sourceReference.referenceId,
								receiver: access.binding,
								relativePath,
								signal: access.signal,
							}),
					},
					access.signal,
					access.authorityIsCurrent,
				),
		});
	} catch {
		return { kind: 'unavailable' };
	}
}
