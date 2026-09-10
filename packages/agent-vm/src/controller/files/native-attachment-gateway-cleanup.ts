import type { GatewayZoneDestroyResult } from '../../gateway/gateway-zone-support.js';
import type { NativeAttachmentStaging } from './native-attachment-staging.js';

/** Observe existing exact destruction; this adds no independent VM destruction authority. */
export function createNativeAttachmentGatewayDestroy(props: {
	readonly gateway: {
		readonly gatewayIdentity: { readonly zoneId: string; readonly gatewayVmId: string };
		destroyGateway(): Promise<GatewayZoneDestroyResult>;
	};
	readonly staging: Pick<NativeAttachmentStaging, 'releaseGatewayAfterContainment'>;
}): () => Promise<GatewayZoneDestroyResult> {
	return async () => {
		const result = await props.gateway.destroyGateway();
		// Both result variants prove exact VM destruction. A thrown result does not;
		// unrelated post-destruction cleanup debt must retain its original outcome.
		try {
			await props.staging.releaseGatewayAfterContainment({
				zoneId: props.gateway.gatewayIdentity.zoneId,
				gatewayVmId: props.gateway.gatewayIdentity.gatewayVmId,
			});
		} catch (error) {
			return {
				kind: 'destroyed-cleanup-incomplete',
				cleanupFailures: [
					{ stage: 'native-attachment-cleanup', error },
					...(result.kind === 'destroyed-cleanup-incomplete' ? result.cleanupFailures : []),
				],
			};
		}
		return result;
	};
}
