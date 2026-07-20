import type { GatewayStablePrincipalDigest } from '@agent-vm/agent-portal-sdk/contracts';
import {
	deriveGatewayControlStablePrincipal,
	type GatewayControlToolVmBindingIdentity,
	type GatewayControlToolVmBindingPublication,
	type GatewayRuntimeTrustedInvocationContext,
} from '@agent-vm/gateway-control-contracts';

import type {
	StrictToolVmSshAccess,
	StrictToolVmSshClient,
	StrictToolVmSshProcessChannelClient,
	StrictToolVmSshTransportFailureSubscription,
} from '../sandbox/strict-tool-vm-ssh-client.js';
import type {
	GatewayControlAcceptedSession,
	GatewayControlService,
} from './gateway-control-endpoint-contracts.js';

export type GatewayControlPublishedBindingRetirementReason =
	| 'dead'
	| 'expired'
	| 'released'
	| 'replaced'
	| 'runtime_closed'
	| 'session_retired';

export interface GatewayControlPublishedBindingGeneration {
	readonly agentId: string;
	readonly leafGeneration: string;
	readonly leaseId: string;
	readonly profileAssignmentRevision: string;
	readonly sshBindingId: string;
	readonly stablePrincipal: GatewayStablePrincipalDigest;
	readonly zoneId: string;
}

interface GatewayControlPublishedBindingStateBase {
	readonly generation: GatewayControlPublishedBindingGeneration;
	readonly publicationObservedAtMs: number;
}

export interface GatewayControlPublishedBindingUnboundState {
	readonly kind: 'unbound';
	readonly stablePrincipal: GatewayStablePrincipalDigest;
}

export interface GatewayControlPublishedBindingConnectingState extends GatewayControlPublishedBindingStateBase {
	readonly kind: 'connecting';
}

export interface GatewayControlPublishedBindingReadyState extends GatewayControlPublishedBindingStateBase {
	readonly connectedAtMs: number;
	readonly kind: 'ready';
}

export interface GatewayControlPublishedBindingDegradedState extends GatewayControlPublishedBindingStateBase {
	readonly degradedAtMs: number;
	readonly kind: 'degraded';
	readonly reason: 'connection_failed' | 'transport_failed';
}

export interface GatewayControlPublishedBindingRetiredState extends GatewayControlPublishedBindingStateBase {
	readonly kind: 'retired';
	readonly reason: GatewayControlPublishedBindingRetirementReason;
	readonly retiredAtMs: number;
}

export type GatewayControlPublishedBindingState =
	| GatewayControlPublishedBindingUnboundState
	| GatewayControlPublishedBindingConnectingState
	| GatewayControlPublishedBindingReadyState
	| GatewayControlPublishedBindingDegradedState
	| GatewayControlPublishedBindingRetiredState;

export type GatewayControlPublishedBindingApplyResult =
	| {
			readonly kind: 'applied';
			readonly state: GatewayControlPublishedBindingState;
	  }
	| {
			readonly kind: 'ignored';
			readonly reason:
				| 'binding_authority_mismatch'
				| 'duplicate_publication'
				| 'retirement_identity_mismatch'
				| 'runtime_closed'
				| 'stale_publication';
			readonly state: GatewayControlPublishedBindingState;
	  };

export type GatewayControlPublishedBindingLookupResult =
	| {
			readonly connection: StrictToolVmSshClient & StrictToolVmSshProcessChannelClient;
			readonly generation: GatewayControlPublishedBindingGeneration;
			readonly kind: 'ready';
	  }
	| {
			readonly kind: 'unavailable';
			readonly state: GatewayControlPublishedBindingState;
	  };

export interface CreateGatewayControlPublishedBindingRuntimeProps {
	readonly controlService: Pick<
		GatewayControlService,
		'getCurrentAcceptedSession' | 'observeSessionState'
	>;
	readonly createStrictSshClient: (
		access: StrictToolVmSshAccess,
	) => StrictToolVmSshClient & StrictToolVmSshProcessChannelClient;
	readonly now?: () => number;
}

export interface GatewayControlPublishedBindingRuntime {
	readonly applyPublication: (
		publication: GatewayControlToolVmBindingPublication,
	) => Promise<GatewayControlPublishedBindingApplyResult>;
	readonly close: () => Promise<void>;
	readonly lookupReadyConnection: (request: {
		readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
	}) => GatewayControlPublishedBindingLookupResult;
	readonly readState: (request: {
		readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
	}) => GatewayControlPublishedBindingState;
}

interface PublishedBindingConnectionSlot {
	client: StrictToolVmSshClient & StrictToolVmSshProcessChannelClient;
	closed: boolean;
	readonly generation: GatewayControlPublishedBindingGeneration;
	readonly publicationObservedAtMs: number;
	state: Exclude<GatewayControlPublishedBindingState, GatewayControlPublishedBindingUnboundState>;
	transportFailureSubscription: StrictToolVmSshTransportFailureSubscription | undefined;
	readonly version: number;
}

function publicationAuthorityMatchesAcceptedSession(
	publication: GatewayControlToolVmBindingPublication,
	acceptedSession: GatewayControlAcceptedSession,
): boolean {
	const authority = publication.authority;
	return (
		authority.attachmentGeneration === acceptedSession.attachmentGeneration &&
		authority.connectionId === acceptedSession.connectionId &&
		authority.controllerEpoch === acceptedSession.controllerEpoch &&
		authority.gatewayEpoch === acceptedSession.gatewayEpoch &&
		authority.processEpoch === acceptedSession.processEpoch &&
		authority.sessionId === acceptedSession.sessionId &&
		authority.zoneId === acceptedSession.zoneId
	);
}

function generationFromIdentity(
	binding: GatewayControlToolVmBindingIdentity,
): GatewayControlPublishedBindingGeneration {
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

function generationsMatch(
	left: GatewayControlPublishedBindingGeneration,
	right: GatewayControlPublishedBindingGeneration,
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

function closeSlot(slot: PublishedBindingConnectionSlot): void {
	if (slot.closed) return;
	slot.closed = true;
	slot.transportFailureSubscription?.unsubscribe();
	slot.transportFailureSubscription = undefined;
	try {
		slot.client.close();
	} catch {}
}

function unboundState(
	stablePrincipal: GatewayStablePrincipalDigest,
): GatewayControlPublishedBindingUnboundState {
	return { kind: 'unbound', stablePrincipal };
}

export function createGatewayControlPublishedBindingRuntime(
	props: CreateGatewayControlPublishedBindingRuntimeProps,
): GatewayControlPublishedBindingRuntime {
	const now = props.now ?? Date.now;
	const slotsByStablePrincipal = new Map<
		GatewayStablePrincipalDigest,
		PublishedBindingConnectionSlot
	>();
	let closed = false;
	let nextSlotVersion = 1;

	function retireAllSlotsForSessionChange(): void {
		for (const slot of slotsByStablePrincipal.values()) closeSlot(slot);
		slotsByStablePrincipal.clear();
	}

	const sessionObservation = props.controlService.observeSessionState(
		() => retireAllSlotsForSessionChange(),
		() => undefined,
	);

	function ignoredResult(
		reason: Extract<GatewayControlPublishedBindingApplyResult, { kind: 'ignored' }>['reason'],
		stablePrincipal: GatewayStablePrincipalDigest,
	): GatewayControlPublishedBindingApplyResult {
		return {
			kind: 'ignored',
			reason,
			state: slotsByStablePrincipal.get(stablePrincipal)?.state ?? unboundState(stablePrincipal),
		};
	}

	async function applyCurrent(
		publication: Extract<GatewayControlToolVmBindingPublication, { kind: 'current' }>,
	): Promise<GatewayControlPublishedBindingApplyResult> {
		const generation = generationFromIdentity(publication.binding);
		const existingSlot = slotsByStablePrincipal.get(generation.stablePrincipal);
		if (existingSlot !== undefined) {
			if (generationsMatch(existingSlot.generation, generation)) {
				if (
					existingSlot.state.kind !== 'degraded' ||
					publication.observedAtMs <= existingSlot.publicationObservedAtMs
				) {
					return ignoredResult('duplicate_publication', generation.stablePrincipal);
				}
				closeSlot(existingSlot);
			}
			if (
				!generationsMatch(existingSlot.generation, generation) &&
				publication.observedAtMs <= existingSlot.publicationObservedAtMs
			) {
				return ignoredResult('stale_publication', generation.stablePrincipal);
			}
			if (!existingSlot.closed) closeSlot(existingSlot);
		}

		const client = props.createStrictSshClient({
			host: publication.binding.ssh.host,
			identityPem: publication.binding.ssh.identityPem,
			knownHostsLine: publication.binding.ssh.knownHostsLine,
			port: publication.binding.ssh.port,
			user: publication.binding.ssh.user,
		});
		const slotVersion = nextSlotVersion++;
		const slot: PublishedBindingConnectionSlot = {
			client,
			closed: false,
			generation,
			publicationObservedAtMs: publication.observedAtMs,
			state: {
				generation,
				kind: 'connecting',
				publicationObservedAtMs: publication.observedAtMs,
			},
			transportFailureSubscription: undefined,
			version: slotVersion,
		};
		slotsByStablePrincipal.set(generation.stablePrincipal, slot);
		slot.transportFailureSubscription = client.observeTransportFailure(() => {
			if (
				closed ||
				slotsByStablePrincipal.get(generation.stablePrincipal) !== slot ||
				slot.version !== slotVersion
			) {
				return;
			}
			slot.transportFailureSubscription?.unsubscribe();
			slot.transportFailureSubscription = undefined;
			slot.state = {
				degradedAtMs: now(),
				generation,
				kind: 'degraded',
				publicationObservedAtMs: publication.observedAtMs,
				reason: 'transport_failed',
			};
			closeSlot(slot);
		});

		try {
			await client.connect();
		} catch {
			if (!closed && slotsByStablePrincipal.get(generation.stablePrincipal) === slot) {
				slot.transportFailureSubscription?.unsubscribe();
				slot.transportFailureSubscription = undefined;
				slot.state = {
					degradedAtMs: now(),
					generation,
					kind: 'degraded',
					publicationObservedAtMs: publication.observedAtMs,
					reason: 'connection_failed',
				};
				closeSlot(slot);
			}
			return { kind: 'applied', state: slot.state };
		}

		if (closed || slotsByStablePrincipal.get(generation.stablePrincipal) !== slot) {
			closeSlot(slot);
			return ignoredResult(
				closed ? 'runtime_closed' : 'stale_publication',
				generation.stablePrincipal,
			);
		}
		slot.state = {
			connectedAtMs: now(),
			generation,
			kind: 'ready',
			publicationObservedAtMs: publication.observedAtMs,
		};
		return { kind: 'applied', state: slot.state };
	}

	function applyRetired(
		publication: Extract<GatewayControlToolVmBindingPublication, { kind: 'retired' }>,
	): GatewayControlPublishedBindingApplyResult {
		const generation = generationFromIdentity(publication.binding);
		const existingSlot = slotsByStablePrincipal.get(generation.stablePrincipal);
		if (existingSlot === undefined) {
			return ignoredResult('retirement_identity_mismatch', generation.stablePrincipal);
		}
		if (!generationsMatch(existingSlot.generation, generation)) {
			return ignoredResult('retirement_identity_mismatch', generation.stablePrincipal);
		}
		if (publication.observedAtMs < existingSlot.publicationObservedAtMs) {
			return ignoredResult('stale_publication', generation.stablePrincipal);
		}
		closeSlot(existingSlot);
		existingSlot.state = {
			generation,
			kind: 'retired',
			publicationObservedAtMs: publication.observedAtMs,
			reason: publication.reason,
			retiredAtMs: now(),
		};
		return { kind: 'applied', state: existingSlot.state };
	}

	async function applyPublication(
		publication: GatewayControlToolVmBindingPublication,
	): Promise<GatewayControlPublishedBindingApplyResult> {
		const stablePrincipal = publication.binding.stablePrincipal;
		if (closed) return ignoredResult('runtime_closed', stablePrincipal);
		const acceptedSession = props.controlService.getCurrentAcceptedSession();
		if (
			acceptedSession === undefined ||
			!publicationAuthorityMatchesAcceptedSession(publication, acceptedSession) ||
			publication.binding.zoneId !== acceptedSession.zoneId
		) {
			return ignoredResult('binding_authority_mismatch', stablePrincipal);
		}
		return publication.kind === 'current'
			? await applyCurrent(publication)
			: applyRetired(publication);
	}

	function readState(request: {
		readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
	}): GatewayControlPublishedBindingState {
		const stablePrincipal = deriveGatewayControlStablePrincipal({
			principal: request.trustedContext.principal,
		});
		const slot = slotsByStablePrincipal.get(stablePrincipal);
		if (
			slot === undefined ||
			slot.generation.agentId !== request.trustedContext.principal.agentId ||
			slot.generation.profileAssignmentRevision !==
				request.trustedContext.principal.profileAssignmentRevision
		) {
			return unboundState(stablePrincipal);
		}
		return slot.state;
	}

	function lookupReadyConnection(request: {
		readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
	}): GatewayControlPublishedBindingLookupResult {
		const state = readState(request);
		if (state.kind !== 'ready') return { kind: 'unavailable', state };
		const slot = slotsByStablePrincipal.get(state.generation.stablePrincipal);
		if (slot === undefined || slot.state !== state) return { kind: 'unavailable', state };
		return { connection: slot.client, generation: slot.generation, kind: 'ready' };
	}

	async function close(): Promise<void> {
		if (closed) return;
		closed = true;
		sessionObservation.unsubscribe();
		for (const slot of slotsByStablePrincipal.values()) {
			closeSlot(slot);
			slot.state = {
				generation: slot.generation,
				kind: 'retired',
				publicationObservedAtMs: slot.publicationObservedAtMs,
				reason: 'runtime_closed',
				retiredAtMs: now(),
			};
		}
	}

	return { applyPublication, close, lookupReadyConnection, readState };
}
