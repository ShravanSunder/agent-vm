import { describe, expect, it } from 'vitest';

import {
	createManagedPluginAttachmentState,
	GATEWAY_RUNTIME_PROTOCOL_VERSION,
	GATEWAY_RUNTIME_SCHEMA_VERSION,
	MAXIMUM_OBSERVED_MANAGED_PLUGIN_CONNECTION_IDS,
	reduceManagedPluginAttachmentState,
} from './managed-plugin-attachment-policy.js';

type ManagedPluginAttachmentConfig = Parameters<typeof createManagedPluginAttachmentState>[0];
type ManagedPluginAttachmentState = ReturnType<typeof createManagedPluginAttachmentState>;
type ManagedPluginAttachmentEvent = Parameters<typeof reduceManagedPluginAttachmentState>[1];
type ManagedPluginAttachmentTransition = ReturnType<typeof reduceManagedPluginAttachmentState>;
type ManagedPluginAttachmentRejection = Extract<
	ManagedPluginAttachmentTransition['decision'],
	{ readonly kind: 'rejected' }
>;
type ManagedPluginHandshakeEvent = Extract<
	ManagedPluginAttachmentEvent,
	{ readonly kind: 'handshake' }
>;
type ManagedPluginMethodEvent = Extract<ManagedPluginAttachmentEvent, { readonly kind: 'method' }>;
type ManagedPluginDisconnectedEvent = Extract<
	ManagedPluginAttachmentEvent,
	{ readonly kind: 'disconnected' }
>;
type ManagedPluginRetiredEvent = Extract<
	ManagedPluginAttachmentEvent,
	{ readonly kind: 'retired' }
>;

const SERVER_AUTHORITY = {
	allowedOperationGroups: ['tool-portal', 'rich-sandbox'],
	surface: 'managed-plugin',
} as const;

const CURRENT_ATTACHMENT_CONFIG = {
	attachmentGeneration: 7,
	clientKind: 'openclaw-managed-plugin',
	configuredAgentIds: ['main', 'research'],
	frameworkEpoch: 'framework-epoch-current',
	gatewayEpoch: 'gateway-epoch-current',
	projectionCohortDigest:
		'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	runtimeEpoch: 'runtime-epoch-current',
	serverAuthority: SERVER_AUTHORITY,
} satisfies ManagedPluginAttachmentConfig;

const SERVER_CONNECTION_ONE = 'server-connection-1';
const SERVER_CONNECTION_TWO = 'server-connection-2';

function createAttachmentState(): ManagedPluginAttachmentState {
	return createManagedPluginAttachmentState(CURRENT_ATTACHMENT_CONFIG);
}

function createCurrentHandshakeEvent(
	connectionId: string = SERVER_CONNECTION_ONE,
	overrides: Partial<Omit<ManagedPluginHandshakeEvent, 'connectionId' | 'kind'>> = {},
): ManagedPluginHandshakeEvent {
	return {
		attachmentGeneration: CURRENT_ATTACHMENT_CONFIG.attachmentGeneration,
		clientKind: CURRENT_ATTACHMENT_CONFIG.clientKind,
		configuredAgentIds: CURRENT_ATTACHMENT_CONFIG.configuredAgentIds,
		connectionId,
		frameworkEpoch: CURRENT_ATTACHMENT_CONFIG.frameworkEpoch,
		gatewayEpoch: CURRENT_ATTACHMENT_CONFIG.gatewayEpoch,
		kind: 'handshake',
		protocolVersion: GATEWAY_RUNTIME_PROTOCOL_VERSION,
		projectionCohortDigest: CURRENT_ATTACHMENT_CONFIG.projectionCohortDigest,
		runtimeEpoch: CURRENT_ATTACHMENT_CONFIG.runtimeEpoch,
		schemaVersion: GATEWAY_RUNTIME_SCHEMA_VERSION,
		...overrides,
	};
}

function createMethodEvent(connectionId: string): ManagedPluginMethodEvent {
	return {
		connectionId,
		kind: 'method',
		operationGroup: 'tool-portal',
	};
}

function createDisconnectedEvent(connectionId: string): ManagedPluginDisconnectedEvent {
	return {
		connectionId,
		kind: 'disconnected',
	};
}

function createRetiredEvent(): ManagedPluginRetiredEvent {
	return { kind: 'retired' };
}

function expectAcceptedTransition(
	transition: ManagedPluginAttachmentTransition,
): ManagedPluginAttachmentState {
	expect(transition.decision).toMatchObject({ kind: 'accepted' });
	return transition.state;
}

function expectRejectedTransition(
	transition: ManagedPluginAttachmentTransition,
	code: ManagedPluginAttachmentRejection['code'],
): void {
	expect(transition.decision).toMatchObject({
		code,
		kind: 'rejected',
	});
}

function createAttachedState(): ManagedPluginAttachmentState {
	return expectAcceptedTransition(
		reduceManagedPluginAttachmentState(createAttachmentState(), createCurrentHandshakeEvent()),
	);
}

describe('managed-plugin attachment policy', () => {
	it('rejects a method before the connection completes its handshake', () => {
		// Arrange
		const state = createAttachmentState();

		// Act
		const transition = reduceManagedPluginAttachmentState(
			state,
			createMethodEvent(SERVER_CONNECTION_ONE),
		);

		// Assert
		expectRejectedTransition(transition, 'method-before-handshake');
	});

	it('accepts a current handshake and returns only server-owned authority', () => {
		// Arrange
		const state = createAttachmentState();

		// Act
		const transition = reduceManagedPluginAttachmentState(state, createCurrentHandshakeEvent());

		// Assert
		expect(transition.decision).toEqual({
			authority: SERVER_AUTHORITY,
			kind: 'accepted',
		});
	});

	it.each([
		{
			code: 'protocol-version-mismatch' as const,
			createEvent: (): ManagedPluginHandshakeEvent =>
				createCurrentHandshakeEvent(SERVER_CONNECTION_ONE, {
					protocolVersion: GATEWAY_RUNTIME_PROTOCOL_VERSION + 1,
				}),
			versionName: 'protocol',
		},
		{
			code: 'schema-version-mismatch' as const,
			createEvent: (): ManagedPluginHandshakeEvent =>
				createCurrentHandshakeEvent(SERVER_CONNECTION_ONE, {
					schemaVersion: GATEWAY_RUNTIME_SCHEMA_VERSION + 1,
				}),
			versionName: 'schema',
		},
	])('rejects incompatible $versionName versions independently', ({ code, createEvent }) => {
		// Arrange
		const state = createAttachmentState();

		// Act
		const transition = reduceManagedPluginAttachmentState(state, createEvent());

		// Assert
		expectRejectedTransition(transition, code);
	});

	it.each([
		{
			code: 'stale-gateway-epoch' as const,
			createEvent: (): ManagedPluginHandshakeEvent =>
				createCurrentHandshakeEvent(SERVER_CONNECTION_ONE, {
					gatewayEpoch: 'gateway-epoch-stale',
				}),
			epochName: 'Gateway',
		},
		{
			code: 'stale-runtime-epoch' as const,
			createEvent: (): ManagedPluginHandshakeEvent =>
				createCurrentHandshakeEvent(SERVER_CONNECTION_ONE, {
					runtimeEpoch: 'runtime-epoch-stale',
				}),
			epochName: 'runtime',
		},
		{
			code: 'stale-framework-epoch' as const,
			createEvent: (): ManagedPluginHandshakeEvent =>
				createCurrentHandshakeEvent(SERVER_CONNECTION_ONE, {
					frameworkEpoch: 'framework-epoch-stale',
				}),
			epochName: 'framework',
		},
	])('rejects a stale $epochName epoch independently', ({ code, createEvent }) => {
		// Arrange
		const state = createAttachmentState();

		// Act
		const transition = reduceManagedPluginAttachmentState(state, createEvent());

		// Assert
		expectRejectedTransition(transition, code);
	});

	it('rejects a stale managed-plugin attachment generation', () => {
		// Arrange
		const state = createAttachmentState();

		// Act
		const transition = reduceManagedPluginAttachmentState(
			state,
			createCurrentHandshakeEvent(SERVER_CONNECTION_ONE, {
				attachmentGeneration: CURRENT_ATTACHMENT_CONFIG.attachmentGeneration - 1,
			}),
		);

		// Assert
		expectRejectedTransition(transition, 'stale-attachment-generation');
	});

	it.each([
		{
			code: 'wrong-client-kind' as const,
			createEvent: (): ManagedPluginHandshakeEvent =>
				createCurrentHandshakeEvent(SERVER_CONNECTION_ONE, {
					clientKind: 'hermes-managed-plugin',
				}),
			mismatchName: 'client kind',
		},
		{
			code: 'wrong-configured-agent-set' as const,
			createEvent: (): ManagedPluginHandshakeEvent =>
				createCurrentHandshakeEvent(SERVER_CONNECTION_ONE, {
					configuredAgentIds: ['main', 'unconfigured'],
				}),
			mismatchName: 'configured-agent set',
		},
		{
			code: 'wrong-projection-cohort' as const,
			createEvent: (): ManagedPluginHandshakeEvent =>
				createCurrentHandshakeEvent(SERVER_CONNECTION_ONE, {
					projectionCohortDigest:
						'projection-cohort:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
				}),
			mismatchName: 'projection cohort digest',
		},
	])('rejects the wrong $mismatchName', ({ code, createEvent }) => {
		// Arrange
		const state = createAttachmentState();

		// Act
		const transition = reduceManagedPluginAttachmentState(state, createEvent());

		// Assert
		expectRejectedTransition(transition, code);
	});

	it.each([
		{
			fieldName: 'authority',
			publicFields: {
				authority: {
					allowedOperationGroups: ['controller-runner'],
					surface: 'public-mcp',
				},
			},
		},
		{
			fieldName: 'surface',
			publicFields: { surface: 'public-mcp' },
		},
		{
			fieldName: 'allowed operation groups',
			publicFields: { allowedOperationGroups: ['controller-runner'] },
		},
	])('rejects public $fieldName injection', ({ publicFields }) => {
		// Arrange
		const state = createAttachmentState();
		const event = {
			...createCurrentHandshakeEvent(),
			...publicFields,
		};

		// Act
		const transition = reduceManagedPluginAttachmentState(state, event);

		// Assert
		expectRejectedTransition(transition, 'public-authority-injection');
	});

	it('rejects a concurrent connection while the attachment has an active owner', () => {
		// Arrange
		const attachedState = createAttachedState();

		// Act
		const transition = reduceManagedPluginAttachmentState(
			attachedState,
			createCurrentHandshakeEvent(SERVER_CONNECTION_TWO),
		);

		// Assert
		expectRejectedTransition(transition, 'duplicate-active-connection');
	});

	it('rejects replay of a connection id observed before disconnect', () => {
		// Arrange
		const attachedState = createAttachedState();
		const disconnectedState = expectAcceptedTransition(
			reduceManagedPluginAttachmentState(
				attachedState,
				createDisconnectedEvent(SERVER_CONNECTION_ONE),
			),
		);

		// Act
		const transition = reduceManagedPluginAttachmentState(
			disconnectedState,
			createCurrentHandshakeEvent(SERVER_CONNECTION_ONE),
		);

		// Assert
		expectRejectedTransition(transition, 'replayed-connection');
	});

	it('fails closed when unique handshake attempts exhaust connection history capacity', () => {
		// Arrange
		let state = createAttachmentState();
		const firstObservedConnectionId = 'capacity-connection-0';
		for (
			let connectionIndex = 0;
			connectionIndex < MAXIMUM_OBSERVED_MANAGED_PLUGIN_CONNECTION_IDS;
			connectionIndex += 1
		) {
			const connectionId = `capacity-connection-${connectionIndex}`;
			const staleHandshakeTransition = reduceManagedPluginAttachmentState(
				state,
				createCurrentHandshakeEvent(connectionId, {
					gatewayEpoch: 'gateway-epoch-stale',
				}),
			);
			expectRejectedTransition(staleHandshakeTransition, 'stale-gateway-epoch');
			state = staleHandshakeTransition.state;
		}
		const stateAtCapacity = state;

		// Act
		const unseenConnectionTransition = reduceManagedPluginAttachmentState(
			stateAtCapacity,
			createCurrentHandshakeEvent('capacity-connection-unseen'),
		);
		const replayedConnectionTransition = reduceManagedPluginAttachmentState(
			unseenConnectionTransition.state,
			createCurrentHandshakeEvent(firstObservedConnectionId),
		);

		// Assert
		expect(stateAtCapacity.observedConnectionIds).toHaveLength(
			MAXIMUM_OBSERVED_MANAGED_PLUGIN_CONNECTION_IDS,
		);
		expect(unseenConnectionTransition.decision).toEqual({
			code: 'connection-history-capacity-exceeded',
			kind: 'rejected',
		});
		expect(unseenConnectionTransition.state.observedConnectionIds).toEqual(
			stateAtCapacity.observedConnectionIds,
		);
		expect(unseenConnectionTransition.state.observedConnectionIds).not.toContain(
			'capacity-connection-unseen',
		);
		expectRejectedTransition(replayedConnectionTransition, 'replayed-connection');
		expect(replayedConnectionTransition.state.observedConnectionIds).toEqual(
			stateAtCapacity.observedConnectionIds,
		);
	});

	it('treats configured agent identifiers as an order-insensitive set', () => {
		// Arrange
		const state = createAttachmentState();
		const reorderedAgentSetHandshake = createCurrentHandshakeEvent(SERVER_CONNECTION_ONE, {
			configuredAgentIds: CURRENT_ATTACHMENT_CONFIG.configuredAgentIds.toReversed(),
		});

		// Act
		const transition = reduceManagedPluginAttachmentState(state, reorderedAgentSetHandshake);

		// Assert
		expectAcceptedTransition(transition);
	});

	it('admits methods only from the active connection owner', () => {
		// Arrange
		const attachedState = createAttachedState();

		// Act
		const ownerTransition = reduceManagedPluginAttachmentState(
			attachedState,
			createMethodEvent(SERVER_CONNECTION_ONE),
		);
		const otherConnectionTransition = reduceManagedPluginAttachmentState(
			attachedState,
			createMethodEvent(SERVER_CONNECTION_TWO),
		);

		// Assert
		expect(ownerTransition.decision).toMatchObject({ kind: 'accepted' });
		expectRejectedTransition(otherConnectionTransition, 'wrong-connection');
	});

	it('allows the same valid generation to reattach after disconnect without new authority', () => {
		// Arrange
		const firstHandshake = reduceManagedPluginAttachmentState(
			createAttachmentState(),
			createCurrentHandshakeEvent(SERVER_CONNECTION_ONE),
		);
		const attachedState = expectAcceptedTransition(firstHandshake);
		const disconnectedState = expectAcceptedTransition(
			reduceManagedPluginAttachmentState(
				attachedState,
				createDisconnectedEvent(SERVER_CONNECTION_ONE),
			),
		);

		// Act
		const secondHandshake = reduceManagedPluginAttachmentState(
			disconnectedState,
			createCurrentHandshakeEvent(SERVER_CONNECTION_TWO),
		);

		// Assert
		expect(secondHandshake.decision).toEqual(firstHandshake.decision);
		expect(secondHandshake.decision).toEqual({
			authority: SERVER_AUTHORITY,
			kind: 'accepted',
		});
	});

	it('makes retirement terminal for new handshakes and old-owner methods', () => {
		// Arrange
		const attachedState = createAttachedState();
		const retiredState = expectAcceptedTransition(
			reduceManagedPluginAttachmentState(attachedState, createRetiredEvent()),
		);

		// Act
		const laterHandshake = reduceManagedPluginAttachmentState(
			retiredState,
			createCurrentHandshakeEvent(SERVER_CONNECTION_TWO),
		);
		const oldOwnerMethod = reduceManagedPluginAttachmentState(
			retiredState,
			createMethodEvent(SERVER_CONNECTION_ONE),
		);

		// Assert
		expectRejectedTransition(laterHandshake, 'retired-attachment');
		expectRejectedTransition(oldOwnerMethod, 'retired-attachment');
	});

	it('does not mutate reducer input state for any attachment event kind', () => {
		// Arrange
		const initialState = createAttachmentState();
		const initialSnapshot = structuredClone(initialState);

		// Act
		const handshakeTransition = reduceManagedPluginAttachmentState(
			initialState,
			createCurrentHandshakeEvent(),
		);

		// Assert
		expect(initialState).toEqual(initialSnapshot);
		expect(handshakeTransition.state).not.toBe(initialState);

		// Arrange
		const attachedState = expectAcceptedTransition(handshakeTransition);
		const attachedSnapshot = structuredClone(attachedState);

		// Act
		reduceManagedPluginAttachmentState(attachedState, createMethodEvent(SERVER_CONNECTION_ONE));
		reduceManagedPluginAttachmentState(
			attachedState,
			createDisconnectedEvent(SERVER_CONNECTION_ONE),
		);
		reduceManagedPluginAttachmentState(attachedState, createRetiredEvent());

		// Assert
		expect(attachedState).toEqual(attachedSnapshot);
	});
});
