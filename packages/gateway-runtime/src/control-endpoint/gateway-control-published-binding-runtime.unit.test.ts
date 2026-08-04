import {
	deriveGatewayControlStablePrincipal,
	type GatewayControlToolVmBindingPublication,
	type GatewayRuntimeTrustedInvocationContext,
} from '@agent-vm/gateway-control-contracts';
import { describe, expect, it, vi } from 'vitest';

import { createGatewayRuntimeSandboxOperationAuthority } from '../sandbox/sandbox-operation-authority.js';
import type {
	StrictToolVmSshAccess,
	StrictToolVmSshClient,
	StrictToolVmSshProcessChannelClient,
	StrictToolVmSshTransportFailure,
} from '../sandbox/strict-tool-vm-ssh-client.js';
import type { GatewayControlAcceptedSession } from './gateway-control-endpoint-contracts.js';
import { createGatewayControlPublishedBindingRuntime } from './gateway-control-published-binding-runtime.js';

const acceptedSession = Object.freeze({
	attachmentGeneration: 3,
	bootId: 'boot-a',
	connectionId: '11111111-1111-4111-8111-111111111111',
	controllerEpoch: 'controller-a',
	gatewayEpoch: 'gateway-a',
	generationId: 'gateway-a',
	peerId: 'gateway-zone-a',
	processEpoch: 'process-a',
	sessionId: '22222222-2222-4222-8222-222222222222',
	zoneId: 'zone-a',
}) satisfies GatewayControlAcceptedSession;

const replacementSession = Object.freeze({
	...acceptedSession,
	attachmentGeneration: 4,
	connectionId: '33333333-3333-4333-8333-333333333333',
	sessionId: '44444444-4444-4444-8444-444444444444',
}) satisfies GatewayControlAcceptedSession;

const trustedContextA = Object.freeze({
	principal: {
		agentId: 'agent-a',
		frameworkIdentity: { agentId: 'openclaw-agent-a', kind: 'openclaw' },
		profileAssignmentRevision: 'assignment-a-1',
		toolPortalProfileId: 'builder',
	},
}) satisfies GatewayRuntimeTrustedInvocationContext;

const trustedContextB = Object.freeze({
	principal: {
		agentId: 'agent-b',
		frameworkIdentity: { kind: 'hermes', profileName: 'hermes-profile-b' },
		profileAssignmentRevision: 'assignment-b-1',
		toolPortalProfileId: 'builder',
	},
}) satisfies GatewayRuntimeTrustedInvocationContext;

interface Deferred<TValue> {
	readonly promise: Promise<TValue>;
	readonly reject: (error: Error) => void;
	readonly resolve: (value: TValue) => void;
}

function deferred<TValue>(): Deferred<TValue> {
	let rejectPromise: ((error: Error) => void) | undefined;
	let resolvePromise: ((value: TValue) => void) | undefined;
	const promise = new Promise<TValue>((resolve, reject) => {
		rejectPromise = reject;
		resolvePromise = resolve;
	});
	return {
		promise,
		reject: (error) => rejectPromise?.(error),
		resolve: (value) => resolvePromise?.(value),
	};
}

interface StrictSshClientFixture {
	readonly client: StrictToolVmSshClient & StrictToolVmSshProcessChannelClient;
	readonly close: ReturnType<typeof vi.fn>;
	readonly connect: ReturnType<typeof vi.fn>;
	emitTransportFailure(failure: StrictToolVmSshTransportFailure): void;
	getObserverCount(): number;
}

function createStrictSshClientFixture(
	connectImplementation: () => Promise<void> = async () => undefined,
): StrictSshClientFixture {
	const transportFailureObservers = new Set<(failure: StrictToolVmSshTransportFailure) => void>();
	const close = vi.fn((options?: { readonly notifyTransportFailure?: true }): void => {
		if (options?.notifyTransportFailure !== true) return;
		for (const observer of transportFailureObservers) {
			observer({ kind: 'transport-close' });
		}
	});
	const connect = vi.fn(connectImplementation);
	const client = {
		close,
		connect,
		execute: vi.fn(async () => ({
			exitCode: 0,
			kind: 'exited' as const,
			stderr: new Uint8Array(),
			stdout: new Uint8Array(),
		})),
		guestListDirectory: vi.fn(async () => []),
		guestMkdir: vi.fn(async () => undefined),
		guestReadFile: vi.fn(async () => new Uint8Array()),
		guestRemove: vi.fn(async () => undefined),
		guestRename: vi.fn(async () => undefined),
		guestStat: vi.fn(async () => ({ byteLength: 0, kind: 'file' as const })),
		guestWriteFile: vi.fn(async () => undefined),
		listDirectory: vi.fn(async () => []),
		mkdir: vi.fn(async () => undefined),
		observeTransportFailure: vi.fn(
			(observer: (failure: StrictToolVmSshTransportFailure) => void) => {
				transportFailureObservers.add(observer);
				return { unsubscribe: () => transportFailureObservers.delete(observer) };
			},
		),
		openProcessChannel: vi.fn(async () => ({
			endInput: () => undefined,
			requestCancellation: () => undefined,
			resizeTerminal: () => undefined,
			write: async () => undefined,
		})),
		openShellProcessChannel: vi.fn(async () => ({
			endInput: () => undefined,
			requestCancellation: () => undefined,
			resizeTerminal: () => undefined,
			write: async () => undefined,
		})),
		readFile: vi.fn(async () => new Uint8Array()),
		remove: vi.fn(async () => undefined),
		rename: vi.fn(async () => undefined),
		stat: vi.fn(async () => ({ byteLength: 0, kind: 'file' as const })),
		writeFile: vi.fn(async () => undefined),
	} satisfies StrictToolVmSshClient & StrictToolVmSshProcessChannelClient;
	return {
		client,
		close,
		connect,
		emitTransportFailure: (failure) => {
			for (const observer of transportFailureObservers) observer(failure);
		},
		getObserverCount: () => transportFailureObservers.size,
	};
}

function publicationAuthority(
	session: GatewayControlAcceptedSession = acceptedSession,
	overrides: Partial<GatewayControlToolVmBindingPublication['authority']> = {},
): GatewayControlToolVmBindingPublication['authority'] {
	return {
		attachmentGeneration: session.attachmentGeneration,
		connectionId: session.connectionId,
		controllerEpoch: session.controllerEpoch,
		gatewayEpoch: session.gatewayEpoch,
		processEpoch: session.processEpoch,
		sessionId: session.sessionId,
		zoneId: session.zoneId,
		...overrides,
	};
}

function currentPublication(
	props: {
		readonly leafGeneration?: string;
		readonly leaseId?: string;
		readonly observedAtMs?: number;
		readonly session?: GatewayControlAcceptedSession;
		readonly sshBindingId?: string;
		readonly trustedContext?: GatewayRuntimeTrustedInvocationContext;
	} = {},
): Extract<GatewayControlToolVmBindingPublication, { kind: 'current' }> {
	const trustedContext = props.trustedContext ?? trustedContextA;
	return {
		authority: publicationAuthority(props.session),
		binding: {
			agentId: trustedContext.principal.agentId,
			idleTtlMs: 60_000,
			leafGeneration: props.leafGeneration ?? 'leaf-a-1',
			leaseId: props.leaseId ?? 'lease-a-1',
			profileAssignmentRevision: trustedContext.principal.profileAssignmentRevision,
			ssh: {
				host: '127.0.0.1',
				identityPem: 'private-key-material',
				knownHostsLine: '127.0.0.1 ssh-ed25519 AAAAC3Nza',
				port: 2201,
				user: 'agent',
			},
			sshBindingId: props.sshBindingId ?? 'ssh-a-1',
			stablePrincipal: deriveGatewayControlStablePrincipal({
				principal: trustedContext.principal,
			}),
			tcpSlot: 0,
			transport: 'ssh-sandbox',
			workdir: '/work',
			zoneId: acceptedSession.zoneId,
		},
		kind: 'current',
		observedAtMs: props.observedAtMs ?? 100,
	};
}

function retiredPublication(
	current: Extract<GatewayControlToolVmBindingPublication, { kind: 'current' }>,
	overrides: Partial<
		Extract<GatewayControlToolVmBindingPublication, { kind: 'retired' }>['binding']
	> = {},
): Extract<GatewayControlToolVmBindingPublication, { kind: 'retired' }> {
	return {
		authority: current.authority,
		binding: {
			agentId: current.binding.agentId,
			leafGeneration: current.binding.leafGeneration,
			leaseId: current.binding.leaseId,
			profileAssignmentRevision: current.binding.profileAssignmentRevision,
			sshBindingId: current.binding.sshBindingId,
			stablePrincipal: current.binding.stablePrincipal,
			zoneId: current.binding.zoneId,
			...overrides,
		},
		kind: 'retired',
		observedAtMs: current.observedAtMs + 1,
		reason: 'replaced',
	};
}

interface RuntimeFixture {
	readonly clients: readonly StrictSshClientFixture[];
	readonly createInputs: readonly StrictToolVmSshAccess[];
	readonly runtime: ReturnType<typeof createGatewayControlPublishedBindingRuntime>;
	setSession(session: GatewayControlAcceptedSession | undefined): void;
}

function createRuntimeFixture(
	clientFixtures: readonly StrictSshClientFixture[],
	options: { readonly now?: () => number } = {},
): RuntimeFixture {
	const createInputs: StrictToolVmSshAccess[] = [];
	const sessionObservers = new Set<(session: GatewayControlAcceptedSession | undefined) => void>();
	let clientIndex = 0;
	let currentSession: GatewayControlAcceptedSession | undefined = acceptedSession;
	const runtime = createGatewayControlPublishedBindingRuntime({
		controlService: {
			getCurrentAcceptedSession: () => currentSession,
			observeSessionState: (observer) => {
				sessionObservers.add(observer);
				return { unsubscribe: () => sessionObservers.delete(observer) };
			},
		},
		createStrictSshClient: (access) => {
			createInputs.push(access);
			const fixture = clientFixtures[clientIndex++];
			if (fixture === undefined) throw new Error('Unexpected strict SSH client creation.');
			return fixture.client;
		},
		now: options.now ?? (() => 500),
	});
	return {
		clients: clientFixtures,
		createInputs,
		runtime,
		setSession: (session) => {
			currentSession = session;
			for (const observer of sessionObservers) observer(session);
		},
	};
}

function applyPublication(
	runtime: ReturnType<typeof createGatewayControlPublishedBindingRuntime>,
	publication: GatewayControlToolVmBindingPublication,
	context: { readonly expiresAtMs: number } = { expiresAtMs: Number.MAX_SAFE_INTEGER },
): ReturnType<ReturnType<typeof createGatewayControlPublishedBindingRuntime>['applyPublication']> {
	return runtime.applyPublication(publication, context);
}

describe('Gateway control published binding runtime', () => {
	it('proactively connects a current publication without starting active use', async () => {
		// Arrange
		const client = createStrictSshClientFixture();
		const fixture = createRuntimeFixture([client]);
		const publication = currentPublication();

		// Act
		const result = await applyPublication(fixture.runtime, publication);

		// Assert
		expect(result).toMatchObject({ kind: 'applied', state: { kind: 'ready' } });
		expect(client.connect).toHaveBeenCalledOnce();
		expect(fixture.createInputs).toEqual([publication.binding.ssh]);
		expect(JSON.stringify(result)).not.toContain(publication.binding.ssh.identityPem);
		expect(
			fixture.runtime.lookupReadyConnection({ trustedContext: trustedContextA }),
		).toMatchObject({
			connection: client.client,
			kind: 'ready',
		});
	});

	it('keeps different agents in independent connection slots', async () => {
		// Arrange
		const clientA = createStrictSshClientFixture();
		const clientB = createStrictSshClientFixture();
		const fixture = createRuntimeFixture([clientA, clientB]);

		// Act
		await Promise.all([
			applyPublication(fixture.runtime, currentPublication()),
			applyPublication(
				fixture.runtime,
				currentPublication({
					leafGeneration: 'leaf-b-1',
					leaseId: 'lease-b-1',
					sshBindingId: 'ssh-b-1',
					trustedContext: trustedContextB,
				}),
			),
		]);

		// Assert
		expect(
			fixture.runtime.lookupReadyConnection({ trustedContext: trustedContextA }),
		).toMatchObject({ connection: clientA.client, kind: 'ready' });
		expect(
			fixture.runtime.lookupReadyConnection({ trustedContext: trustedContextB }),
		).toMatchObject({ connection: clientB.client, kind: 'ready' });
	});

	it('rejects accepted-session mismatches and stale successor publications', async () => {
		// Arrange
		const client = createStrictSshClientFixture();
		const fixture = createRuntimeFixture([client]);
		const current = currentPublication({ observedAtMs: 200 });
		await applyPublication(fixture.runtime, current);
		const wrongSession = {
			...currentPublication({ leafGeneration: 'leaf-a-2', observedAtMs: 300 }),
			authority: publicationAuthority(acceptedSession, {
				sessionId: '33333333-3333-4333-8333-333333333333',
			}),
		};
		const stale = currentPublication({
			leafGeneration: 'leaf-a-stale',
			observedAtMs: 199,
			sshBindingId: 'ssh-a-stale',
		});

		// Act
		const wrongSessionResult = await applyPublication(fixture.runtime, wrongSession);
		const staleResult = await applyPublication(fixture.runtime, stale);

		// Assert
		expect(wrongSessionResult).toMatchObject({
			kind: 'ignored',
			reason: 'binding_authority_mismatch',
		});
		expect(staleResult).toMatchObject({ kind: 'ignored', reason: 'stale_publication' });
		expect(fixture.createInputs).toHaveLength(1);
		expect(client.close).not.toHaveBeenCalled();
	});

	it('fences old operation authority before ending its transport during binding replacement', async () => {
		// Arrange
		const originalClient = createStrictSshClientFixture();
		const replacementClient = createStrictSshClientFixture();
		const fixture = createRuntimeFixture([originalClient, replacementClient]);
		const originalPublication = currentPublication();
		await applyPublication(fixture.runtime, originalPublication);
		const operationContext = {
			activeUseId: '55555555-5555-4555-8555-555555555555',
			environmentGeneration: 'environment-a-1',
			gatewayEpoch: acceptedSession.gatewayEpoch,
			leafGeneration: originalPublication.binding.leafGeneration,
			leaseId: originalPublication.binding.leaseId,
			sshBindingId: originalPublication.binding.sshBindingId,
			stablePrincipal: originalPublication.binding.stablePrincipal,
		};
		const operationAuthority = createGatewayRuntimeSandboxOperationAuthority(operationContext);
		originalClient.client.observeTransportFailure(() => {
			operationAuthority.beginReplacement({ replacementLeafGeneration: 'leaf-a-2' });
		});
		const authorityAtTransportEnd: string[] = [];
		originalClient.close.mockImplementation(
			(options?: { readonly notifyTransportFailure?: true }): void => {
				if (options?.notifyTransportFailure === true) {
					originalClient.emitTransportFailure({ kind: 'transport-close' });
				}
				authorityAtTransportEnd.push(operationAuthority.authorize(operationContext).kind);
			},
		);

		// Act
		await applyPublication(
			fixture.runtime,
			currentPublication({
				leafGeneration: 'leaf-a-2',
				leaseId: 'lease-a-2',
				observedAtMs: 200,
				sshBindingId: 'ssh-a-2',
			}),
		);

		// Assert
		expect(authorityAtTransportEnd).toEqual(['stale-operation-authority']);
		expect(originalClient.close).toHaveBeenCalledWith({ notifyTransportFailure: true });
	});

	it('retires old-session slots and accepts a publication from the replacement session', async () => {
		// Arrange
		const originalClient = createStrictSshClientFixture();
		const replacementClient = createStrictSshClientFixture();
		const fixture = createRuntimeFixture([originalClient, replacementClient]);
		await applyPublication(fixture.runtime, currentPublication({ observedAtMs: 500 }));

		// Act
		fixture.setSession(replacementSession);
		const result = await applyPublication(
			fixture.runtime,
			currentPublication({
				leafGeneration: 'leaf-a-2',
				leaseId: 'lease-a-2',
				observedAtMs: 1,
				session: replacementSession,
				sshBindingId: 'ssh-a-2',
			}),
		);

		// Assert
		expect(originalClient.close).toHaveBeenCalledOnce();
		expect(result).toMatchObject({ kind: 'applied', state: { kind: 'ready' } });
		expect(
			fixture.runtime.lookupReadyConnection({ trustedContext: trustedContextA }),
		).toMatchObject({ connection: replacementClient.client, generation: { leaseId: 'lease-a-2' } });
	});

	it('treats a duplicate exact current publication as idempotent', async () => {
		// Arrange
		const client = createStrictSshClientFixture();
		const fixture = createRuntimeFixture([client]);
		const publication = currentPublication();
		await applyPublication(fixture.runtime, publication);

		// Act
		const result = await applyPublication(fixture.runtime, { ...publication, observedAtMs: 101 });

		// Assert
		expect(result).toMatchObject({ kind: 'ignored', reason: 'duplicate_publication' });
		expect(client.connect).toHaveBeenCalledOnce();
		expect(client.close).not.toHaveBeenCalled();
	});

	it('prevents a delayed predecessor connection from overwriting its successor', async () => {
		// Arrange
		const predecessorConnect = deferred<void>();
		const predecessor = createStrictSshClientFixture(() => predecessorConnect.promise);
		const successor = createStrictSshClientFixture();
		const fixture = createRuntimeFixture([predecessor, successor]);
		const predecessorPublication = currentPublication({ observedAtMs: 100 });
		const successorPublication = currentPublication({
			leafGeneration: 'leaf-a-2',
			leaseId: 'lease-a-2',
			observedAtMs: 200,
			sshBindingId: 'ssh-a-2',
		});
		const predecessorResultPromise = applyPublication(fixture.runtime, predecessorPublication);
		await vi.waitFor(() => expect(predecessor.connect).toHaveBeenCalledOnce());

		// Act
		const successorResult = await applyPublication(fixture.runtime, successorPublication);
		predecessorConnect.resolve(undefined);
		const predecessorResult = await predecessorResultPromise;

		// Assert
		expect(successorResult).toMatchObject({ kind: 'applied', state: { kind: 'ready' } });
		expect(predecessorResult).toMatchObject({ kind: 'ignored', reason: 'stale_publication' });
		expect(predecessor.close).toHaveBeenCalled();
		expect(
			fixture.runtime.lookupReadyConnection({ trustedContext: trustedContextA }),
		).toMatchObject({ connection: successor.client, generation: { leaseId: 'lease-a-2' } });
	});

	it('makes exact retirement unavailable before synchronous close and preserves the identity matrix', async () => {
		// Arrange
		const client = createStrictSshClientFixture();
		const fixture = createRuntimeFixture([client]);
		const current = currentPublication();
		await applyPublication(fixture.runtime, current);
		const routingKindsObservedDuringClose: string[] = [];
		client.close.mockImplementation(() => {
			const lookup = fixture.runtime.lookupReadyConnection({ trustedContext: trustedContextA });
			routingKindsObservedDuringClose.push(
				lookup.kind === 'ready' ? lookup.kind : `${lookup.kind}:${lookup.state.kind}`,
			);
		});

		// Act
		const mismatchedResult = await applyPublication(
			fixture.runtime,
			retiredPublication(current, { leaseId: 'lease-predecessor' }),
		);
		const exactResult = await applyPublication(fixture.runtime, retiredPublication(current));
		const duplicateResult = await applyPublication(fixture.runtime, retiredPublication(current));

		// Assert
		expect(mismatchedResult).toMatchObject({
			kind: 'ignored',
			reason: 'retirement_identity_mismatch',
		});
		expect(exactResult).toMatchObject({
			kind: 'applied',
			state: { kind: 'retired', reason: 'replaced' },
		});
		expect(duplicateResult).toMatchObject({
			kind: 'applied',
			state: { kind: 'retired', reason: 'replaced' },
		});
		expect(routingKindsObservedDuringClose).toEqual(['unavailable:retired']);
		expect(client.close).toHaveBeenCalledOnce();
		expect(client.close).toHaveBeenCalledWith({ notifyTransportFailure: true });
		expect(
			fixture.runtime.lookupReadyConnection({ trustedContext: trustedContextA }),
		).toMatchObject({
			kind: 'unavailable',
			state: { kind: 'retired' },
		});
	});

	it('prevents delayed connect completion from restoring an exactly retired slot', async () => {
		// Arrange
		const pendingConnect = deferred<void>();
		const client = createStrictSshClientFixture(() => pendingConnect.promise);
		const fixture = createRuntimeFixture([client]);
		const current = currentPublication();
		const currentResultPromise = applyPublication(fixture.runtime, current);
		await vi.waitFor(() => expect(client.connect).toHaveBeenCalledOnce());

		// Act
		const retirementResult = await applyPublication(fixture.runtime, retiredPublication(current));
		pendingConnect.resolve(undefined);
		const lateCurrentResult = await currentResultPromise;

		// Assert
		expect(retirementResult).toMatchObject({
			kind: 'applied',
			state: { kind: 'retired', reason: 'replaced' },
		});
		expect(lateCurrentResult).toMatchObject({ kind: 'ignored', reason: 'stale_publication' });
		expect(client.close).toHaveBeenCalledOnce();
		expect(
			fixture.runtime.lookupReadyConnection({ trustedContext: trustedContextA }),
		).toMatchObject({
			kind: 'unavailable',
			state: { kind: 'retired', reason: 'replaced' },
		});
	});

	it('does not make a binding ready after its publication command expires', async () => {
		// Arrange
		let nowMs = 100;
		const pendingConnect = deferred<void>();
		const client = createStrictSshClientFixture(() => pendingConnect.promise);
		const fixture = createRuntimeFixture([client], { now: () => nowMs });
		const current = currentPublication();
		const routingKindsObservedDuringClose: string[] = [];
		client.close.mockImplementation(() => {
			const lookup = fixture.runtime.lookupReadyConnection({ trustedContext: trustedContextA });
			routingKindsObservedDuringClose.push(
				lookup.kind === 'ready' ? lookup.kind : `${lookup.kind}:${lookup.state.kind}`,
			);
		});
		const currentResultPromise = applyPublication(fixture.runtime, current, { expiresAtMs: 110 });
		await vi.waitFor(() => expect(client.connect).toHaveBeenCalledOnce());

		// Act
		nowMs = 110;
		pendingConnect.resolve(undefined);
		const lateCurrentResult = await currentResultPromise;

		// Assert
		expect(lateCurrentResult).toMatchObject({ kind: 'ignored', reason: 'stale_publication' });
		expect(client.close).toHaveBeenCalledOnce();
		expect(routingKindsObservedDuringClose).toEqual(['unavailable:unbound']);
		expect(
			fixture.runtime.lookupReadyConnection({ trustedContext: trustedContextA }),
		).toMatchObject({ kind: 'unavailable', state: { kind: 'unbound' } });
	});

	it('moves a failed proactive connection to degraded without exposing it', async () => {
		// Arrange
		const client = createStrictSshClientFixture(async () => {
			throw new Error('sensitive transport failure');
		});
		const fixture = createRuntimeFixture([client]);

		// Act
		const result = await applyPublication(fixture.runtime, currentPublication());

		// Assert
		expect(result).toMatchObject({
			kind: 'applied',
			state: { kind: 'degraded', reason: 'connection_failed' },
		});
		expect(JSON.stringify(result)).not.toContain('sensitive transport failure');
		expect(client.close).toHaveBeenCalledOnce();
		expect(
			fixture.runtime.lookupReadyConnection({ trustedContext: trustedContextA }),
		).toMatchObject({
			kind: 'unavailable',
			state: { kind: 'degraded' },
		});
	});

	it('reconnects a degraded exact binding when the controller republishes it', async () => {
		// Arrange
		const failedClient = createStrictSshClientFixture(async () => {
			throw new Error('first connection failed');
		});
		const replacementClient = createStrictSshClientFixture();
		const fixture = createRuntimeFixture([failedClient, replacementClient]);
		const publication = currentPublication({ observedAtMs: 100 });
		await applyPublication(fixture.runtime, publication);

		// Act
		const result = await applyPublication(fixture.runtime, {
			...publication,
			observedAtMs: 101,
		});

		// Assert
		expect(result).toMatchObject({ kind: 'applied', state: { kind: 'ready' } });
		expect(replacementClient.connect).toHaveBeenCalledOnce();
		expect(
			fixture.runtime.lookupReadyConnection({ trustedContext: trustedContextA }),
		).toMatchObject({ connection: replacementClient.client, kind: 'ready' });
	});

	it('degrades a ready slot on transport failure and closes every slot at runtime close', async () => {
		// Arrange
		const clientA = createStrictSshClientFixture();
		const clientB = createStrictSshClientFixture();
		const fixture = createRuntimeFixture([clientA, clientB]);
		await applyPublication(fixture.runtime, currentPublication());
		await applyPublication(
			fixture.runtime,
			currentPublication({
				leafGeneration: 'leaf-b-1',
				leaseId: 'lease-b-1',
				sshBindingId: 'ssh-b-1',
				trustedContext: trustedContextB,
			}),
		);

		// Act
		clientA.emitTransportFailure({ kind: 'transport-close' });
		await fixture.runtime.close();
		const closedResult = await applyPublication(
			fixture.runtime,
			currentPublication({ leafGeneration: 'leaf-a-2', observedAtMs: 200 }),
		);

		// Assert
		expect(clientA.close).toHaveBeenCalledOnce();
		expect(clientB.close).toHaveBeenCalledOnce();
		expect(clientB.close.mock.calls).toEqual([[]]);
		expect(clientA.getObserverCount()).toBe(0);
		expect(clientB.getObserverCount()).toBe(0);
		expect(fixture.runtime.readState({ trustedContext: trustedContextA })).toMatchObject({
			kind: 'retired',
			reason: 'runtime_closed',
		});
		expect(closedResult).toMatchObject({ kind: 'ignored', reason: 'runtime_closed' });
	});
});
