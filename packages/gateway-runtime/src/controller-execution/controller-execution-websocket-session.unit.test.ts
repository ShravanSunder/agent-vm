import { Buffer } from 'node:buffer';

import type {
	ControllerExecutionDataCredit,
	ControllerExecutionDataFrame,
	ControllerExecutionDataHandshake,
} from '@agent-vm/controller-execution-contracts/controller-execution-data-boundary';
import { describe, expect, it, vi } from 'vitest';

import {
	createControllerExecutionDataChannel,
	type ControllerExecutionDataChannel,
} from './controller-execution-data-channel.js';
import { createControllerExecutionWebSocketSession } from './controller-execution-websocket-session.js';

const binding = {
	audience: 'controller-execution-data',
	channelId: 'channel-a',
	controllerEpoch: 'controller-epoch-a',
	executionFingerprint: 'fingerprint-a',
	gatewayEpoch: 'gateway-epoch-a',
	operationId: 'operation-a',
	runtimeEpoch: 'runtime-epoch-a',
	stablePrincipal: 'a'.repeat(64),
} as const;

const handshake = {
	...binding,
	kind: 'handshake',
} as const satisfies ControllerExecutionDataHandshake;

const workLaneLimits = {
	codec: { maxConcurrentTasks: 1, maxQueuedTasks: 0 },
	execution: { maxConcurrentTasks: 1, maxQueuedTasks: 0 },
} as const;

interface Deferred<TValue> {
	readonly promise: Promise<TValue>;
	readonly resolve: (value: TValue) => void;
}

type ControllerExecutionDataFrameVariant = Extract<
	ControllerExecutionDataFrame,
	{ readonly kind: 'data' }
>;

type ControllerExecutionTerminalFrameVariant = Extract<
	ControllerExecutionDataFrame,
	{ readonly kind: 'cancel' | 'eof' }
>;

interface ControllerExecutionWebSocketSessionFixture {
	readonly channel: ControllerExecutionDataChannel;
	readonly close: (closeRequest: {
		readonly code: number;
		readonly reason: string;
	}) => Promise<void>;
	readonly onData: (data: Uint8Array) => Promise<void>;
	readonly onTerminal: (terminal: {
		readonly terminalKind: ControllerExecutionTerminalFrameVariant['kind'];
	}) => Promise<void>;
	readonly sendText: (text: string) => Promise<void>;
	readonly session: ReturnType<typeof createControllerExecutionWebSocketSession>;
}

function createDataFrame(
	overrides: Partial<ControllerExecutionDataFrameVariant> = {},
): ControllerExecutionDataFrameVariant {
	return {
		...binding,
		creditBytes: 1024,
		kind: 'data',
		payloadBase64: 'AQID',
		sequence: 0,
		...overrides,
	};
}

function createTerminalFrame(
	terminalKind: ControllerExecutionTerminalFrameVariant['kind'],
): ControllerExecutionTerminalFrameVariant {
	return {
		...binding,
		creditBytes: 1024,
		kind: terminalKind,
		sequence: 0,
	};
}

function createSessionFixture(maxMessageBytes = 4096): ControllerExecutionWebSocketSessionFixture {
	const channel = createControllerExecutionDataChannel({
		binding,
		deadlineMilliseconds: {
			heartbeat: 1_000,
			'recovery-admission': 1_000,
			'safety-cancel': 1_000,
		},
		limits: { initialCreditBytes: 1024, maxQueuedBytes: 1024 },
		workLaneLimits,
		runtime: {
			clock: { now: (): number => 0 },
			scheduler: {
				schedule: (): void => {
					throw new Error('WebSocket session unit tests must not schedule deadlines.');
				},
			},
		},
	});
	const close = vi.fn(async (): Promise<void> => undefined);
	const onData = vi.fn(async (_data: Uint8Array): Promise<void> => undefined);
	const onTerminal = vi.fn(
		async (_terminal: {
			readonly terminalKind: ControllerExecutionTerminalFrameVariant['kind'];
		}): Promise<void> => undefined,
	);
	const sendText = vi.fn(async (_text: string): Promise<void> => undefined);
	const session = createControllerExecutionWebSocketSession({
		channel,
		close,
		limits: { maxMessageBytes },
		onData,
		onTerminal,
		sendText,
	});

	return {
		channel,
		close,
		onData,
		onTerminal,
		sendText,
		session,
	};
}

async function authenticateAndHandshake(
	fixture: ControllerExecutionWebSocketSessionFixture,
): Promise<void> {
	expect(fixture.session.activateAuthenticatedUpgrade()).toEqual({
		kind: 'accepted',
	});
	await expect(fixture.session.receiveText(JSON.stringify(handshake))).resolves.toMatchObject({
		kind: 'accepted',
	});
	expect(fixture.sendText).toHaveBeenCalledExactlyOnceWith(
		JSON.stringify({
			...binding,
			availableCreditBytes: 1024,
			kind: 'credit',
			nextSequence: 0,
			queuedBytes: 0,
		} satisfies ControllerExecutionDataCredit),
	);
	vi.mocked(fixture.sendText).mockClear();
}

describe('controller execution WebSocket session authentication and handshake', () => {
	it('requires authenticated upgrade activation before parsing any handshake', async () => {
		const fixture = createSessionFixture();
		const authenticateHandshake = vi.spyOn(fixture.channel, 'authenticateHandshake');

		await expect(fixture.session.receiveText(JSON.stringify(handshake))).resolves.toEqual({
			kind: 'rejected',
			reason: 'upgrade-not-authenticated',
		});
		expect(authenticateHandshake).not.toHaveBeenCalled();
		expect(fixture.close).toHaveBeenCalledOnce();
	});

	it('requires a strict shared handshake as the first authenticated message', async () => {
		const fixture = createSessionFixture();
		expect(fixture.session.activateAuthenticatedUpgrade()).toEqual({
			kind: 'accepted',
		});

		await expect(fixture.session.receiveText(JSON.stringify(createDataFrame()))).resolves.toEqual({
			kind: 'rejected',
			reason: 'handshake-required',
		});
		expect(fixture.onData).not.toHaveBeenCalled();
		expect(fixture.close).toHaveBeenCalledOnce();
	});

	it('passes the strict handshake binding to the channel authority', async () => {
		const fixture = createSessionFixture();
		const authenticateHandshake = vi.spyOn(fixture.channel, 'authenticateHandshake');
		expect(fixture.session.activateAuthenticatedUpgrade()).toEqual({
			kind: 'accepted',
		});

		await expect(fixture.session.receiveText(JSON.stringify(handshake))).resolves.toMatchObject({
			kind: 'accepted',
		});
		expect(authenticateHandshake).toHaveBeenCalledExactlyOnceWith(handshake);
		expect(fixture.sendText).toHaveBeenCalledExactlyOnceWith(
			JSON.stringify({
				...binding,
				availableCreditBytes: 1024,
				kind: 'credit',
				nextSequence: 0,
				queuedBytes: 0,
			} satisfies ControllerExecutionDataCredit),
		);
		expect(fixture.close).not.toHaveBeenCalled();
	});

	it('fails closed when initial bound credit cannot reach the controller', async () => {
		const fixture = createSessionFixture();
		vi.mocked(fixture.sendText).mockRejectedValueOnce(new Error('transport unavailable'));
		expect(fixture.session.activateAuthenticatedUpgrade()).toEqual({
			kind: 'accepted',
		});

		await expect(fixture.session.receiveText(JSON.stringify(handshake))).resolves.toEqual({
			kind: 'rejected',
			reason: 'transport-failed',
		});
		expect(fixture.close).toHaveBeenCalledOnce();
	});

	it('closes when the channel rejects an otherwise valid handshake binding', async () => {
		const fixture = createSessionFixture();
		expect(fixture.session.activateAuthenticatedUpgrade()).toEqual({
			kind: 'accepted',
		});
		const staleHandshake = { ...handshake, runtimeEpoch: 'runtime-epoch-stale' };

		await expect(fixture.session.receiveText(JSON.stringify(staleHandshake))).resolves.toEqual({
			kind: 'rejected',
			reason: 'binding-mismatch',
		});
		expect(fixture.close).toHaveBeenCalledOnce();
	});
});

describe('controller execution WebSocket session strict bounded parsing', () => {
	it('fails closed for malformed JSON', async () => {
		const fixture = createSessionFixture();
		expect(fixture.session.activateAuthenticatedUpgrade()).toEqual({
			kind: 'accepted',
		});

		await expect(fixture.session.receiveText('{')).resolves.toEqual({
			kind: 'rejected',
			reason: 'invalid-message',
		});
		expect(fixture.close).toHaveBeenCalledOnce();
	});

	it('uses the strict shared schema and rejects unknown handshake fields', async () => {
		const fixture = createSessionFixture();
		expect(fixture.session.activateAuthenticatedUpgrade()).toEqual({
			kind: 'accepted',
		});
		const handshakeWithUnknownAuthority = { ...handshake, controllerProxy: true };

		await expect(
			fixture.session.receiveText(JSON.stringify(handshakeWithUnknownAuthority)),
		).resolves.toEqual({ kind: 'rejected', reason: 'invalid-message' });
		expect(fixture.close).toHaveBeenCalledOnce();
	});

	it('counts UTF-8 bytes against the configured message budget before schema work', async () => {
		const oversizedHandshakeText = JSON.stringify({
			...handshake,
			channelId: `channel-${'🔥'.repeat(64)}`,
		});
		expect(Buffer.byteLength(oversizedHandshakeText, 'utf8')).toBeGreaterThan(
			oversizedHandshakeText.length,
		);
		const fixture = createSessionFixture(oversizedHandshakeText.length);
		const authenticateHandshake = vi.spyOn(fixture.channel, 'authenticateHandshake');
		expect(fixture.session.activateAuthenticatedUpgrade()).toEqual({
			kind: 'accepted',
		});

		await expect(fixture.session.receiveText(oversizedHandshakeText)).resolves.toEqual({
			kind: 'rejected',
			reason: 'message-too-large',
		});
		expect(authenticateHandshake).not.toHaveBeenCalled();
		expect(fixture.close).toHaveBeenCalledOnce();
	});

	it('rejects a second handshake instead of treating it as an execution frame', async () => {
		const fixture = createSessionFixture();
		await authenticateAndHandshake(fixture);

		await expect(fixture.session.receiveText(JSON.stringify(handshake))).resolves.toEqual({
			kind: 'rejected',
			reason: 'invalid-message',
		});
		expect(fixture.close).toHaveBeenCalledOnce();
	});
});

describe('controller execution WebSocket session frames and explicit credit', () => {
	it('delivers decoded data as Uint8Array only after channel admission', async () => {
		const fixture = createSessionFixture();
		await authenticateAndHandshake(fixture);

		await expect(
			fixture.session.receiveText(JSON.stringify(createDataFrame())),
		).resolves.toMatchObject({
			kind: 'accepted',
			nextSequence: 1,
		});
		expect(fixture.onData).toHaveBeenCalledExactlyOnceWith(Uint8Array.from([1, 2, 3]));
		expect(fixture.sendText).not.toHaveBeenCalled();
	});

	it('returns credit only when the consumer explicitly reports consumed data', async () => {
		const fixture = createSessionFixture();
		await authenticateAndHandshake(fixture);
		await fixture.session.receiveText(JSON.stringify(createDataFrame()));
		expect(fixture.sendText).not.toHaveBeenCalled();

		const expectedCredit = {
			...binding,
			availableCreditBytes: 1024,
			kind: 'credit',
			nextSequence: 1,
			queuedBytes: 0,
		} as const satisfies ControllerExecutionDataCredit;
		await expect(fixture.session.consumeData({ consumedBytes: 3 })).resolves.toEqual(
			expectedCredit,
		);
		expect(fixture.sendText).toHaveBeenCalledExactlyOnceWith(JSON.stringify(expectedCredit));
	});

	it('fails closed when the data consumer cannot take admitted bytes', async () => {
		const fixture = createSessionFixture();
		await authenticateAndHandshake(fixture);
		vi.mocked(fixture.onData).mockRejectedValueOnce(new Error('consumer unavailable'));

		await expect(fixture.session.receiveText(JSON.stringify(createDataFrame()))).resolves.toEqual({
			kind: 'rejected',
			reason: 'consumer-failed',
		});
		expect(fixture.close).toHaveBeenCalledOnce();
	});

	it('fails closed when returned credit cannot reach the controller', async () => {
		const fixture = createSessionFixture();
		await authenticateAndHandshake(fixture);
		await fixture.session.receiveText(JSON.stringify(createDataFrame()));
		vi.mocked(fixture.sendText).mockRejectedValueOnce(new Error('transport unavailable'));

		await expect(fixture.session.consumeData({ consumedBytes: 3 })).resolves.toEqual({
			kind: 'rejected',
			reason: 'transport-failed',
		});
		expect(fixture.close).toHaveBeenCalledOnce();
	});

	it('fails closed without delivering a frame whose binding is wrong', async () => {
		const fixture = createSessionFixture();
		await authenticateAndHandshake(fixture);

		await expect(
			fixture.session.receiveText(
				JSON.stringify(createDataFrame({ operationId: 'attacker-operation' })),
			),
		).resolves.toEqual({ kind: 'rejected', reason: 'binding-mismatch' });
		expect(fixture.onData).not.toHaveBeenCalled();
		expect(fixture.close).toHaveBeenCalledOnce();
	});

	it('fails closed on frame replay and never delivers replayed bytes', async () => {
		const fixture = createSessionFixture();
		await authenticateAndHandshake(fixture);
		const frameText = JSON.stringify(createDataFrame());
		await fixture.session.receiveText(frameText);

		await expect(fixture.session.receiveText(frameText)).resolves.toEqual({
			kind: 'rejected',
			reason: 'invalid-sequence',
		});
		expect(fixture.onData).toHaveBeenCalledOnce();
		expect(fixture.close).toHaveBeenCalledOnce();
	});

	it.each(['eof', 'cancel'] as const)(
		'delivers one %s terminal event and fails closed on a duplicate terminal frame',
		async (terminalKind) => {
			const fixture = createSessionFixture();
			await authenticateAndHandshake(fixture);
			const terminalFrameText = JSON.stringify(createTerminalFrame(terminalKind));

			await expect(fixture.session.receiveText(terminalFrameText)).resolves.toEqual({
				kind: 'terminal',
				terminalKind,
			});
			expect(fixture.onTerminal).toHaveBeenCalledExactlyOnceWith({ terminalKind });
			await expect(fixture.session.receiveText(terminalFrameText)).resolves.toEqual({
				kind: 'rejected',
				reason: 'duplicate-terminal-frame',
			});
			expect(fixture.onTerminal).toHaveBeenCalledOnce();
			expect(fixture.close).toHaveBeenCalledOnce();
		},
	);

	it('uses the channel-owned scheduler for codec, channel admission, and consumer work', async () => {
		const fixture = createSessionFixture();
		await authenticateAndHandshake(fixture);
		const runBulkTask = vi.spyOn(fixture.channel.workScheduler, 'runBulkTask');

		await expect(
			fixture.session.receiveText(JSON.stringify(createDataFrame())),
		).resolves.toMatchObject({ kind: 'accepted' });

		expect(runBulkTask.mock.calls.map(([workKind]) => workKind)).toEqual([
			'codec',
			'execution',
			'execution',
		]);
	});

	it('fails closed with a typed bounded reason when codec capacity is exhausted', async () => {
		const fixture = createSessionFixture();
		await authenticateAndHandshake(fixture);
		const heldCodecTask = createDeferred<void>();
		const saturatedCodec = fixture.channel.workScheduler.runBulkTask(
			'codec',
			async (): Promise<void> => await heldCodecTask.promise,
		);
		await Promise.resolve();

		await expect(fixture.session.receiveText(JSON.stringify(createDataFrame()))).resolves.toEqual({
			kind: 'rejected',
			reason: 'codec-capacity-exceeded',
		});
		expect(fixture.close).toHaveBeenCalledExactlyOnceWith({
			code: 1008,
			reason: 'codec-capacity-exceeded',
		});
		heldCodecTask.resolve();
		await saturatedCodec;
	});

	it('forwards transport close notification to the channel ambiguity authority', async () => {
		const fixture = createSessionFixture();
		await authenticateAndHandshake(fixture);
		await fixture.session.receiveText(JSON.stringify(createDataFrame()));

		fixture.session.notifyTransportClosed();

		expect(fixture.channel.state()).toEqual({
			closureKind: 'ambiguous',
			kind: 'closed',
			queuedBytes: 3,
			redispatchAllowed: false,
		});
	});
});

function createDeferred<TValue>(): Deferred<TValue> {
	let resolvePromise: ((value: TValue) => void) | undefined;
	const promise = new Promise<TValue>((resolve) => {
		resolvePromise = resolve;
	});
	if (resolvePromise === undefined) throw new Error('Expected a deferred resolver.');
	return { promise, resolve: resolvePromise };
}
