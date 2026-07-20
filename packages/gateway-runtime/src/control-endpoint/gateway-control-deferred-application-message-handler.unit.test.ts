import { describe, expect, it, vi } from 'vitest';

import {
	createGatewayControlDeferredApplicationMessageHandler,
	GatewayControlDeferredApplicationMessageHandlerSettlementError,
} from './gateway-control-deferred-application-message-handler.js';
import type {
	GatewayControlApplicationMessageContext,
	GatewayControlApplicationMessageHandler,
} from './gateway-control-endpoint-contracts.js';

function context(): GatewayControlApplicationMessageContext {
	return {
		envelope: {
			bootId: 'boot-a',
			commandId: '11111111-1111-4111-8111-111111111111',
			connectionId: '22222222-2222-4222-8222-222222222222',
			controllerEpoch: 'controller-a',
			createdAtMs: 100,
			deliveryPolicy: 'critical_idempotent',
			domain: 'gateway_control',
			expiresAtMs: 10_100,
			idempotencyKey: 'test:control-ping',
			kind: 'command',
			messageId: '33333333-3333-4333-8333-333333333333',
			operation: 'control_ping',
			peerId: 'gateway-zone-a',
			protocolVersion: 1,
			sequence: 1,
			sessionId: '44444444-4444-4444-8444-444444444444',
			zoneId: 'zone-a',
		},
		payload: { kind: 'command', operation: 'control_ping', payload: {} },
	};
}

function applicationHandler(result: unknown): {
	readonly handle: ReturnType<typeof vi.fn<GatewayControlApplicationMessageHandler['handle']>>;
	readonly handler: GatewayControlApplicationMessageHandler;
} {
	const handle = vi.fn<GatewayControlApplicationMessageHandler['handle']>(async () => result);
	return {
		handle,
		handler: {
			buildHandlerFailureResult: () => {
				throw new Error('bound failure builder must not replace protocol-stable behavior');
			},
			handle,
			messageIdentity: () => {
				throw new Error('bound identity must not replace protocol-stable behavior');
			},
		},
	};
}

describe('Gateway control deferred application message handler', () => {
	it('waits for the single binding before delegating an accepted application call', async () => {
		// Arrange
		const deferredHandler = createGatewayControlDeferredApplicationMessageHandler();
		const boundHandler = applicationHandler({ result: 'bound' });
		const applicationContext = context();

		// Act
		const pendingResult = deferredHandler.handler.handle(applicationContext);
		await Promise.resolve();

		// Assert
		expect(boundHandler.handle).not.toHaveBeenCalled();

		// Act
		deferredHandler.bind(boundHandler.handler);

		// Assert
		await expect(pendingResult).resolves.toEqual({ result: 'bound' });
		expect(boundHandler.handle).toHaveBeenCalledExactlyOnceWith(applicationContext);
	});

	it('delegates directly after binding while retaining protocol-stable synchronous methods', async () => {
		// Arrange
		const deferredHandler = createGatewayControlDeferredApplicationMessageHandler();
		const boundHandler = applicationHandler({ result: 'bound' });
		const applicationContext = context();
		deferredHandler.bind(boundHandler.handler);

		// Act
		const identity = deferredHandler.handler.messageIdentity(applicationContext);
		const failure = deferredHandler.handler.buildHandlerFailureResult?.(
			applicationContext,
			new Error('test failure'),
		);
		const result = await deferredHandler.handler.handle(applicationContext);

		// Assert
		expect(identity).toEqual({ kind: 'command', operation: 'control_ping' });
		expect(failure).toMatchObject({
			kind: 'command_result',
			operation: 'control_ping',
			payload: { result: 'failed' },
		});
		expect(result).toEqual({ result: 'bound' });
	});

	it('rejects pending and future application calls with the exact terminal failure', async () => {
		// Arrange
		const deferredHandler = createGatewayControlDeferredApplicationMessageHandler();
		const terminalFailure = new Error('composition failed');
		const pendingResult = deferredHandler.handler.handle(context());

		// Act
		deferredHandler.fail(terminalFailure);

		// Assert
		await expect(pendingResult).rejects.toBe(terminalFailure);
		await expect(deferredHandler.handler.handle(context())).rejects.toBe(terminalFailure);
		expect(() => deferredHandler.bind(applicationHandler(undefined).handler)).toThrow(
			GatewayControlDeferredApplicationMessageHandlerSettlementError,
		);
	});

	it('rejects failure after binding without disturbing the bound handler', async () => {
		// Arrange
		const deferredHandler = createGatewayControlDeferredApplicationMessageHandler();
		const boundHandler = applicationHandler({ result: 'bound' });
		deferredHandler.bind(boundHandler.handler);

		// Act and assert
		expect(() => deferredHandler.fail(new Error('late failure'))).toThrow(
			GatewayControlDeferredApplicationMessageHandlerSettlementError,
		);
		await expect(deferredHandler.handler.handle(context())).resolves.toEqual({ result: 'bound' });
	});

	it('rejects duplicate bind and duplicate fail attempts explicitly', () => {
		// Arrange
		const boundDeferredHandler = createGatewayControlDeferredApplicationMessageHandler();
		const boundHandler = applicationHandler(undefined).handler;
		boundDeferredHandler.bind(boundHandler);
		const failedDeferredHandler = createGatewayControlDeferredApplicationMessageHandler();
		failedDeferredHandler.fail(new Error('composition failed'));

		// Act and assert
		expect(() => boundDeferredHandler.bind(boundHandler)).toThrow(
			GatewayControlDeferredApplicationMessageHandlerSettlementError,
		);
		expect(() => failedDeferredHandler.fail(new Error('duplicate failure'))).toThrow(
			GatewayControlDeferredApplicationMessageHandlerSettlementError,
		);
	});
});
