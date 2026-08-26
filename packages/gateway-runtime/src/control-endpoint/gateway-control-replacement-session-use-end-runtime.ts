import type { GatewayStablePrincipalDigest } from '@agent-vm/agent-portal-sdk/contracts';
import type { GatewayRuntimeTrustedInvocationContext } from '@agent-vm/gateway-control-contracts';

import type {
	GatewayControlCallerContextRegistrationClient,
	GatewayControlRegisteredCallerContext,
} from './gateway-control-caller-context-registration-client.js';
import type {
	GatewayControlAcceptedSession,
	GatewayControlService,
} from './gateway-control-endpoint-contracts.js';

export type GatewayControlOperationActiveUseReleaseReason =
	| 'cancelled'
	| 'completed'
	| 'failed'
	| 'timed_out';

interface PendingReplacementSessionUseEnd {
	readonly leaseId: string;
	readonly reason: GatewayControlOperationActiveUseReleaseReason;
	readonly useId: string;
}

export interface CreateGatewayControlReplacementSessionUseEndRuntimeProps {
	readonly callerContextRegistrationClient: Pick<
		GatewayControlCallerContextRegistrationClient,
		'register'
	>;
	readonly controlService: Pick<GatewayControlService, 'getCurrentAcceptedSession'>;
	readonly endUse: (request: {
		readonly acceptedSession: GatewayControlAcceptedSession;
		readonly callerContext: GatewayControlRegisteredCallerContext;
		readonly leaseId: string;
		readonly reason: GatewayControlOperationActiveUseReleaseReason;
		readonly useId: string;
	}) => Promise<boolean>;
}

export interface GatewayControlReplacementSessionUseEndRuntime {
	readonly close: () => void;
	readonly queue: (request: {
		readonly leaseId: string;
		readonly reason: GatewayControlOperationActiveUseReleaseReason;
		readonly stablePrincipal: GatewayStablePrincipalDigest;
		readonly useId: string;
	}) => void;
	readonly settle: (request: {
		readonly stablePrincipal: GatewayStablePrincipalDigest;
		readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
	}) => Promise<boolean>;
}

export function createGatewayControlReplacementSessionUseEndRuntime(
	props: CreateGatewayControlReplacementSessionUseEndRuntimeProps,
): GatewayControlReplacementSessionUseEndRuntime {
	const pendingUsesByPrincipal = new Map<
		GatewayStablePrincipalDigest,
		Map<string, PendingReplacementSessionUseEnd>
	>();
	const settlementsByPrincipal = new Map<
		GatewayStablePrincipalDigest,
		{
			readonly acceptedSession: GatewayControlAcceptedSession;
			readonly promise: Promise<boolean>;
		}
	>();
	let closed = false;

	function queue(request: {
		readonly leaseId: string;
		readonly reason: GatewayControlOperationActiveUseReleaseReason;
		readonly stablePrincipal: GatewayStablePrincipalDigest;
		readonly useId: string;
	}): void {
		if (closed) return;
		let pendingUses = pendingUsesByPrincipal.get(request.stablePrincipal);
		if (pendingUses === undefined) {
			pendingUses = new Map();
			pendingUsesByPrincipal.set(request.stablePrincipal, pendingUses);
		}
		pendingUses.set(request.useId, {
			leaseId: request.leaseId,
			reason: request.reason,
			useId: request.useId,
		});
	}

	async function settle(request: {
		readonly stablePrincipal: GatewayStablePrincipalDigest;
		readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
	}): Promise<boolean> {
		const pendingUses = pendingUsesByPrincipal.get(request.stablePrincipal);
		if (pendingUses === undefined || pendingUses.size === 0) return true;
		const acceptedSession = props.controlService.getCurrentAcceptedSession();
		if (closed || acceptedSession === undefined) return false;
		const existingSettlement = settlementsByPrincipal.get(request.stablePrincipal);
		if (existingSettlement?.acceptedSession === acceptedSession) {
			return await existingSettlement.promise;
		}
		const settlementPromise = (async (): Promise<boolean> => {
			try {
				const callerContext = await props.callerContextRegistrationClient.register({
					purpose: 'tool_vm_lease',
					trustedContext: request.trustedContext,
				});
				if (
					closed ||
					callerContext.admissionPrincipal !== request.stablePrincipal ||
					props.controlService.getCurrentAcceptedSession() !== acceptedSession
				) {
					return false;
				}
				const useEndResults = await Promise.all(
					Array.from(pendingUses.values(), async (pendingUse) => ({
						ended: await props.endUse({
							acceptedSession,
							callerContext,
							leaseId: pendingUse.leaseId,
							reason: pendingUse.reason,
							useId: pendingUse.useId,
						}),
						useId: pendingUse.useId,
					})),
				);
				for (const result of useEndResults) {
					if (result.ended) pendingUses.delete(result.useId);
				}
				if (useEndResults.some((result) => !result.ended)) return false;
				if (pendingUses.size === 0) {
					pendingUsesByPrincipal.delete(request.stablePrincipal);
				}
				return true;
			} catch {
				return false;
			}
		})();
		settlementsByPrincipal.set(request.stablePrincipal, {
			acceptedSession,
			promise: settlementPromise,
		});
		try {
			return await settlementPromise;
		} finally {
			if (settlementsByPrincipal.get(request.stablePrincipal)?.promise === settlementPromise) {
				settlementsByPrincipal.delete(request.stablePrincipal);
			}
		}
	}

	return {
		close: () => {
			closed = true;
			pendingUsesByPrincipal.clear();
			settlementsByPrincipal.clear();
		},
		queue,
		settle,
	};
}
