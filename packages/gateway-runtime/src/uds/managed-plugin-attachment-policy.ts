import { z } from 'zod/v4';

export const GATEWAY_RUNTIME_PROTOCOL_VERSION = 1;
export const GATEWAY_RUNTIME_SCHEMA_VERSION = 1;
export const MAXIMUM_OBSERVED_MANAGED_PLUGIN_CONNECTION_IDS = 256;

export const ManagedPluginClientKindSchema = z.literal('hermes-managed-plugin');

export type ManagedPluginClientKind = z.infer<typeof ManagedPluginClientKindSchema>;

export interface ManagedPluginServerAuthority {
	readonly allowedOperationGroups: readonly string[];
	readonly surface: 'managed-plugin';
}

export interface CreateManagedPluginAttachmentStateOptions {
	readonly attachmentGeneration: number;
	readonly clientKind: ManagedPluginClientKind;
	readonly configuredAgentIds: readonly string[];
	readonly frameworkEpoch: string;
	readonly gatewayEpoch: string;
	readonly projectionCohortDigest: string;
	readonly runtimeEpoch: string;
	readonly serverAuthority: ManagedPluginServerAuthority;
}

interface ManagedPluginAttachmentConfiguration extends CreateManagedPluginAttachmentStateOptions {
	readonly configuredAgentIds: readonly string[];
	readonly serverAuthority: ManagedPluginServerAuthority;
}

export interface ManagedPluginAttachmentState {
	readonly activeConnectionId?: string;
	readonly configuration: ManagedPluginAttachmentConfiguration;
	readonly observedConnectionIds: readonly string[];
	readonly status: 'awaiting-handshake' | 'attached' | 'retired';
}

export interface ManagedPluginHandshakeEvent {
	readonly attachmentGeneration: number;
	readonly clientKind: ManagedPluginClientKind;
	readonly configuredAgentIds: readonly string[];
	readonly connectionId: string;
	readonly frameworkEpoch: string;
	readonly gatewayEpoch: string;
	readonly kind: 'handshake';
	readonly protocolVersion: number;
	readonly projectionCohortDigest: string;
	readonly runtimeEpoch: string;
	readonly schemaVersion: number;
}

export interface ManagedPluginMethodEvent {
	readonly connectionId: string;
	readonly kind: 'method';
	readonly operationGroup: string;
}

export interface ManagedPluginDisconnectedEvent {
	readonly connectionId: string;
	readonly kind: 'disconnected';
}

export interface ManagedPluginRetiredEvent {
	readonly kind: 'retired';
}

export type ManagedPluginAttachmentEvent =
	| ManagedPluginHandshakeEvent
	| ManagedPluginMethodEvent
	| ManagedPluginDisconnectedEvent
	| ManagedPluginRetiredEvent;

export type ManagedPluginAttachmentRejectionCode =
	| 'connection-history-capacity-exceeded'
	| 'duplicate-active-connection'
	| 'invalid-handshake'
	| 'method-before-handshake'
	| 'operation-group-not-allowed'
	| 'protocol-version-mismatch'
	| 'public-authority-injection'
	| 'replayed-connection'
	| 'retired-attachment'
	| 'schema-version-mismatch'
	| 'stale-attachment-generation'
	| 'stale-framework-epoch'
	| 'stale-gateway-epoch'
	| 'stale-runtime-epoch'
	| 'wrong-configured-agent-set'
	| 'wrong-connection'
	| 'wrong-client-kind'
	| 'wrong-projection-cohort';

export type ManagedPluginAttachmentDecision =
	| {
			readonly authority?: ManagedPluginServerAuthority;
			readonly kind: 'accepted';
	  }
	| {
			readonly code: ManagedPluginAttachmentRejectionCode;
			readonly kind: 'rejected';
	  };

export interface ManagedPluginAttachmentTransition {
	readonly decision: ManagedPluginAttachmentDecision;
	readonly state: ManagedPluginAttachmentState;
}

const attachmentConfigurationSchema = z
	.object({
		attachmentGeneration: z.number().int().positive(),
		clientKind: ManagedPluginClientKindSchema,
		configuredAgentIds: z.array(z.string().min(1).max(256)).min(1).max(128),
		frameworkEpoch: z.string().min(1).max(256),
		gatewayEpoch: z.string().min(1).max(256),
		projectionCohortDigest: z.string().regex(/^projection-cohort:[a-f0-9]{64}$/u),
		runtimeEpoch: z.string().min(1).max(256),
		serverAuthority: z
			.object({
				allowedOperationGroups: z.array(z.string().min(1).max(128)).min(1).max(32),
				surface: z.literal('managed-plugin'),
			})
			.strict(),
	})
	.strict();

const handshakeEventSchema = z
	.object({
		attachmentGeneration: z.number().int().positive(),
		clientKind: ManagedPluginClientKindSchema,
		configuredAgentIds: z.array(z.string().min(1).max(256)).min(1).max(128),
		connectionId: z.string().min(1).max(256),
		frameworkEpoch: z.string().min(1).max(256),
		gatewayEpoch: z.string().min(1).max(256),
		kind: z.literal('handshake'),
		protocolVersion: z.number().int().positive(),
		projectionCohortDigest: z.string().regex(/^projection-cohort:[a-f0-9]{64}$/u),
		runtimeEpoch: z.string().min(1).max(256),
		schemaVersion: z.number().int().positive(),
	})
	.strict();

const publicAuthorityFieldNames = [
	'allowedOperationGroups',
	'authority',
	'operationGroups',
	'principal',
	'surface',
] as const;

function hasDuplicateValues(values: readonly string[]): boolean {
	return new Set(values).size !== values.length;
}

function normalizeSet(values: readonly string[]): readonly string[] {
	return values.toSorted((left, right) => left.localeCompare(right));
}

function stringSetsMatch(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length || hasDuplicateValues(left) || hasDuplicateValues(right)) {
		return false;
	}
	const normalizedLeft = normalizeSet(left);
	const normalizedRight = normalizeSet(right);
	return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function assertUnreachableManagedPluginAttachmentEvent(event: never): never {
	throw new Error(`Unsupported managed-plugin attachment event: ${String(event)}`);
}

function acceptedDecision(
	authority?: ManagedPluginServerAuthority,
): ManagedPluginAttachmentDecision {
	return authority === undefined ? { kind: 'accepted' } : { authority, kind: 'accepted' };
}

function rejectedTransition(
	state: ManagedPluginAttachmentState,
	code: ManagedPluginAttachmentRejectionCode,
): ManagedPluginAttachmentTransition {
	return { decision: { code, kind: 'rejected' }, state };
}

function publicAuthorityWasInjected(event: unknown): boolean {
	if (typeof event !== 'object' || event === null || Array.isArray(event)) {
		return false;
	}
	return publicAuthorityFieldNames.some((fieldName) => Object.hasOwn(event, fieldName));
}

function stateWithoutActiveConnection(
	state: ManagedPluginAttachmentState,
	status: 'awaiting-handshake' | 'retired',
): ManagedPluginAttachmentState {
	return {
		configuration: state.configuration,
		observedConnectionIds: state.observedConnectionIds,
		status,
	};
}

function validateHandshakeAgainstCurrentState(
	state: ManagedPluginAttachmentState,
	event: ManagedPluginHandshakeEvent,
): ManagedPluginAttachmentRejectionCode | undefined {
	const configuration = state.configuration;
	if (event.protocolVersion !== GATEWAY_RUNTIME_PROTOCOL_VERSION) {
		return 'protocol-version-mismatch';
	}
	if (event.schemaVersion !== GATEWAY_RUNTIME_SCHEMA_VERSION) {
		return 'schema-version-mismatch';
	}
	if (event.gatewayEpoch !== configuration.gatewayEpoch) return 'stale-gateway-epoch';
	if (event.runtimeEpoch !== configuration.runtimeEpoch) return 'stale-runtime-epoch';
	if (event.frameworkEpoch !== configuration.frameworkEpoch) return 'stale-framework-epoch';
	if (event.attachmentGeneration !== configuration.attachmentGeneration) {
		return 'stale-attachment-generation';
	}
	if (event.clientKind !== configuration.clientKind) return 'wrong-client-kind';
	if (event.projectionCohortDigest !== configuration.projectionCohortDigest) {
		return 'wrong-projection-cohort';
	}
	if (!stringSetsMatch(event.configuredAgentIds, configuration.configuredAgentIds)) {
		return 'wrong-configured-agent-set';
	}
	return undefined;
}

function reduceHandshakeEvent(
	state: ManagedPluginAttachmentState,
	event: ManagedPluginHandshakeEvent,
): ManagedPluginAttachmentTransition {
	if (state.status === 'retired') return rejectedTransition(state, 'retired-attachment');
	if (state.observedConnectionIds.includes(event.connectionId)) {
		return rejectedTransition(state, 'replayed-connection');
	}
	if (state.observedConnectionIds.length >= MAXIMUM_OBSERVED_MANAGED_PLUGIN_CONNECTION_IDS) {
		return rejectedTransition(state, 'connection-history-capacity-exceeded');
	}

	const stateWithObservedConnection = {
		...state,
		observedConnectionIds: [...state.observedConnectionIds, event.connectionId],
	} satisfies ManagedPluginAttachmentState;
	if (state.activeConnectionId !== undefined) {
		return rejectedTransition(stateWithObservedConnection, 'duplicate-active-connection');
	}
	if (publicAuthorityWasInjected(event)) {
		return rejectedTransition(stateWithObservedConnection, 'public-authority-injection');
	}
	const parsedEvent = handshakeEventSchema.safeParse(event);
	if (!parsedEvent.success || hasDuplicateValues(parsedEvent.data.configuredAgentIds)) {
		return rejectedTransition(stateWithObservedConnection, 'invalid-handshake');
	}
	const mismatchCode = validateHandshakeAgainstCurrentState(state, parsedEvent.data);
	if (mismatchCode !== undefined)
		return rejectedTransition(stateWithObservedConnection, mismatchCode);

	return {
		decision: acceptedDecision(state.configuration.serverAuthority),
		state: {
			...stateWithObservedConnection,
			activeConnectionId: parsedEvent.data.connectionId,
			status: 'attached',
		},
	};
}

export function createManagedPluginAttachmentState(
	options: CreateManagedPluginAttachmentStateOptions,
): ManagedPluginAttachmentState {
	const configuration = attachmentConfigurationSchema.parse(options);
	if (
		hasDuplicateValues(configuration.configuredAgentIds) ||
		hasDuplicateValues(configuration.serverAuthority.allowedOperationGroups)
	) {
		throw new Error('Managed-plugin attachment configuration values must be unique.');
	}
	return {
		configuration: {
			...configuration,
			configuredAgentIds: Object.freeze([...configuration.configuredAgentIds]),
			serverAuthority: Object.freeze({
				...configuration.serverAuthority,
				allowedOperationGroups: Object.freeze([
					...configuration.serverAuthority.allowedOperationGroups,
				]),
			}),
		},
		observedConnectionIds: [],
		status: 'awaiting-handshake',
	};
}

export function reduceManagedPluginAttachmentState(
	state: ManagedPluginAttachmentState,
	event: ManagedPluginAttachmentEvent,
): ManagedPluginAttachmentTransition {
	if (state.status === 'retired' && event.kind !== 'retired') {
		return rejectedTransition(state, 'retired-attachment');
	}

	switch (event.kind) {
		case 'handshake':
			return reduceHandshakeEvent(state, event);
		case 'method':
			if (state.activeConnectionId === undefined) {
				return rejectedTransition(state, 'method-before-handshake');
			}
			if (state.activeConnectionId !== event.connectionId) {
				return rejectedTransition(state, 'wrong-connection');
			}
			if (
				!state.configuration.serverAuthority.allowedOperationGroups.includes(event.operationGroup)
			) {
				return rejectedTransition(state, 'operation-group-not-allowed');
			}
			return {
				decision: acceptedDecision(state.configuration.serverAuthority),
				state,
			};
		case 'disconnected':
			if (state.activeConnectionId !== event.connectionId) {
				return rejectedTransition(state, 'wrong-connection');
			}
			return {
				decision: acceptedDecision(),
				state: stateWithoutActiveConnection(state, 'retired'),
			};
		case 'retired':
			return {
				decision: acceptedDecision(),
				state: stateWithoutActiveConnection(state, 'retired'),
			};
	}
	return assertUnreachableManagedPluginAttachmentEvent(event);
}
