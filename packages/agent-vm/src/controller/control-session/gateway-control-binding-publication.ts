import type {
	GatewayControlToolVmBindingAccessGrant,
	GatewayControlToolVmBindingIdentity,
	GatewayControlToolVmBindingPublication,
	GatewayControlToolVmBindingPublicationAuthority,
	GatewayControlToolVmBindingRequestPayload,
	GatewayControlToolVmBindingRequestResult,
} from '@agent-vm/gateway-control-contracts';
import {
	GatewayControlToolVmBindingAccessGrantSchema,
	GatewayControlToolVmBindingPublicationAuthoritySchema,
	GatewayControlToolVmBindingPublicationSchema,
} from '@agent-vm/gateway-control-contracts';

import type { GatewayEpochIdentity } from '../vm-ownership/vm-ownership-contracts.js';
import type { GatewayControlTrustedCallerContext } from './gateway-control-caller-context.js';

export interface GatewayControlToolVmBindingCreator {
	readonly createBinding: (request: {
		readonly callerContext: GatewayControlTrustedCallerContext;
		readonly gateway: GatewayEpochIdentity;
		readonly payload: GatewayControlToolVmBindingRequestPayload;
	}) => Promise<GatewayControlToolVmBindingAccessGrant>;
}

export interface GatewayControlBindingPublicationCoordinatorOptions {
	readonly createBinding: GatewayControlToolVmBindingCreator['createBinding'];
	readonly now?: () => number;
	readonly publish: (
		publication: GatewayControlToolVmBindingPublication,
		options?: { readonly sourceCommandExpiresAtMs: number },
	) => Promise<void>;
	readonly readCurrentAuthority: () => GatewayControlToolVmBindingPublicationAuthority | undefined;
}

export type GatewayControlBindingRetirementPublicationResult =
	| 'not-tracked-on-current-connection'
	| 'publication-applied';

export interface GatewayControlBindingPublicationCoordinator {
	readonly requestBinding: (request: {
		readonly authority: GatewayControlToolVmBindingPublicationAuthority;
		readonly callerContext: GatewayControlTrustedCallerContext;
		readonly expiresAtMs: number;
		readonly gateway: GatewayEpochIdentity;
		readonly payload: GatewayControlToolVmBindingRequestPayload;
	}) => Promise<GatewayControlToolVmBindingRequestResult>;
	readonly retireBinding: (request: {
		readonly authority: GatewayControlToolVmBindingPublicationAuthority;
		readonly leaseId: string;
		readonly reason: Extract<
			GatewayControlToolVmBindingPublication,
			{ readonly kind: 'retired' }
		>['reason'];
	}) => Promise<GatewayControlBindingRetirementPublicationResult>;
}

interface InFlightBindingPublication {
	readonly authority: GatewayControlToolVmBindingPublicationAuthority;
	readonly promise: Promise<GatewayControlToolVmBindingRequestResult>;
}

function authoritiesEqual(
	left: GatewayControlToolVmBindingPublicationAuthority | undefined,
	right: GatewayControlToolVmBindingPublicationAuthority,
): boolean {
	return (
		left !== undefined &&
		left.attachmentGeneration === right.attachmentGeneration &&
		left.connectionId === right.connectionId &&
		left.controllerEpoch === right.controllerEpoch &&
		left.gatewayEpoch === right.gatewayEpoch &&
		left.processEpoch === right.processEpoch &&
		left.sessionId === right.sessionId &&
		left.zoneId === right.zoneId
	);
}

function bindingIdentity(
	binding: GatewayControlToolVmBindingAccessGrant,
): GatewayControlToolVmBindingIdentity {
	return {
		agentId: binding.agentId,
		leafGeneration: binding.leafGeneration,
		leaseId: binding.leaseId,
		profileAssignmentRevision: binding.profileAssignmentRevision,
		sshBindingId: binding.sshBindingId,
		stablePrincipal: binding.stablePrincipal,
		zoneId: binding.zoneId,
	};
}

function bindingsHaveSameIdentity(
	left: GatewayControlToolVmBindingIdentity,
	right: GatewayControlToolVmBindingIdentity,
): boolean {
	return (
		left.agentId === right.agentId &&
		left.leafGeneration === right.leafGeneration &&
		left.leaseId === right.leaseId &&
		left.profileAssignmentRevision === right.profileAssignmentRevision &&
		left.sshBindingId === right.sshBindingId &&
		left.stablePrincipal === right.stablePrincipal &&
		left.zoneId === right.zoneId
	);
}

export function createGatewayControlBindingPublicationCoordinator(
	options: GatewayControlBindingPublicationCoordinatorOptions,
): GatewayControlBindingPublicationCoordinator {
	const now = options.now ?? Date.now;
	const inFlightByPrincipal = new Map<string, InFlightBindingPublication>();
	const currentBindingByPrincipal = new Map<string, GatewayControlToolVmBindingIdentity>();
	let trackedPublicationAuthority: GatewayControlToolVmBindingPublicationAuthority | undefined;
	let lastPublicationObservedAtMs = 0;

	const nextPublicationObservedAtMs = (): number => {
		const observedAtMs = Math.max(1, now(), lastPublicationObservedAtMs + 1);
		lastPublicationObservedAtMs = observedAtMs;
		return observedAtMs;
	};

	const assertCurrentAuthority = (
		authority: GatewayControlToolVmBindingPublicationAuthority,
	): void => {
		GatewayControlToolVmBindingPublicationAuthoritySchema.parse(authority);
		if (!authoritiesEqual(options.readCurrentAuthority(), authority)) {
			throw new Error('Gateway Tool VM binding publication authority is stale.');
		}
	};

	const assertCurrentCommand = (request: {
		readonly authority: GatewayControlToolVmBindingPublicationAuthority;
		readonly expiresAtMs: number;
	}): void => {
		if (!Number.isSafeInteger(request.expiresAtMs) || request.expiresAtMs <= 0) {
			throw new TypeError('Gateway Tool VM binding command expiry must be a positive integer.');
		}
		if (request.expiresAtMs <= now()) {
			throw new Error('Gateway Tool VM binding command expired.');
		}
		assertCurrentAuthority(request.authority);
	};

	const synchronizeTrackedPublicationAuthority = (
		authority: GatewayControlToolVmBindingPublicationAuthority,
	): void => {
		if (authoritiesEqual(trackedPublicationAuthority, authority)) return;
		currentBindingByPrincipal.clear();
		trackedPublicationAuthority = authority;
	};

	const publishRetirement = async (request: {
		readonly authority: GatewayControlToolVmBindingPublicationAuthority;
		readonly binding: GatewayControlToolVmBindingIdentity;
		readonly reason: Extract<
			GatewayControlToolVmBindingPublication,
			{ readonly kind: 'retired' }
		>['reason'];
	}): Promise<void> => {
		assertCurrentAuthority(request.authority);
		await options.publish(
			GatewayControlToolVmBindingPublicationSchema.parse({
				authority: request.authority,
				binding: request.binding,
				kind: 'retired',
				observedAtMs: nextPublicationObservedAtMs(),
				reason: request.reason,
			}),
		);
		assertCurrentAuthority(request.authority);
	};

	return {
		requestBinding: async (request) => {
			assertCurrentCommand(request);
			synchronizeTrackedPublicationAuthority(request.authority);
			const principalKey = request.callerContext.stablePrincipal;
			const existing = inFlightByPrincipal.get(principalKey);
			if (existing !== undefined && authoritiesEqual(existing.authority, request.authority)) {
				return await existing.promise;
			}
			const publication = (async (): Promise<GatewayControlToolVmBindingRequestResult> => {
				const binding = GatewayControlToolVmBindingAccessGrantSchema.parse(
					await options.createBinding({
						callerContext: request.callerContext,
						gateway: request.gateway,
						payload: request.payload,
					}),
				);
				assertCurrentCommand(request);
				if (
					binding.agentId !== request.callerContext.agentId ||
					binding.profileAssignmentRevision !==
						request.callerContext.principal.profileAssignmentRevision ||
					binding.stablePrincipal !== principalKey ||
					binding.zoneId !== request.authority.zoneId
				) {
					throw new Error('Controller-created Tool VM binding does not match its requested agent.');
				}
				const currentIdentity = bindingIdentity(binding);
				const previous = currentBindingByPrincipal.get(principalKey);
				if (
					previous !== undefined &&
					(previous.leaseId !== binding.leaseId ||
						previous.leafGeneration !== binding.leafGeneration ||
						previous.sshBindingId !== binding.sshBindingId)
				) {
					await publishRetirement({
						authority: request.authority,
						binding: previous,
						reason: 'replaced',
					});
					assertCurrentCommand(request);
				}
				await options.publish(
					GatewayControlToolVmBindingPublicationSchema.parse({
						authority: request.authority,
						binding,
						kind: 'current',
						observedAtMs: nextPublicationObservedAtMs(),
					}),
					{ sourceCommandExpiresAtMs: request.expiresAtMs },
				);
				assertCurrentCommand(request);
				currentBindingByPrincipal.set(principalKey, currentIdentity);
				return {
					agentId: binding.agentId,
					stablePrincipal: binding.stablePrincipal,
					status: 'publication_pending',
				};
			})();
			inFlightByPrincipal.set(principalKey, {
				authority: request.authority,
				promise: publication,
			});
			try {
				return await publication;
			} finally {
				if (inFlightByPrincipal.get(principalKey)?.promise === publication) {
					inFlightByPrincipal.delete(principalKey);
				}
			}
		},
		retireBinding: async (request) => {
			assertCurrentAuthority(request.authority);
			synchronizeTrackedPublicationAuthority(request.authority);
			const currentEntry = [...currentBindingByPrincipal.entries()].find(
				([, binding]) => binding.leaseId === request.leaseId,
			);
			if (currentEntry === undefined) return 'not-tracked-on-current-connection';
			const [principalKey, current] = currentEntry;
			await publishRetirement({ ...request, binding: current });
			const currentAfterPublication = currentBindingByPrincipal.get(principalKey);
			if (
				currentAfterPublication !== undefined &&
				bindingsHaveSameIdentity(currentAfterPublication, current)
			) {
				currentBindingByPrincipal.delete(principalKey);
			}
			return 'publication-applied';
		},
	};
}
