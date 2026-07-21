import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	GATEWAY_CONTROL_ADMISSION_PRESSURE_E2E_PATH,
	GATEWAY_CONTROL_ADMISSION_PRESSURE_E2E_SIGNATURE_HEADER,
	createGatewayControlAdmissionPressureE2eRequestHandler,
	gatewayControlAdmissionPressureE2eRouteTestExports,
} from './gateway-control-admission-pressure-e2e-route.js';
import {
	AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_ENV,
	AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_KEY_ENV,
	registerGatewayControlAdmissionPressureE2eActuator,
} from './gateway-control-admission-pressure-e2e-testing.js';

const signingKey = 'gateway-runtime-control-pressure-key';
let unregisterActuator: (() => void) | undefined;

function enableRoute(): void {
	vi.stubEnv(AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_ENV, '1');
	vi.stubEnv(AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_KEY_ENV, signingKey);
}

async function invokeHandler(options: {
	readonly bodyText: string;
	readonly method?: string;
	readonly signature?: string;
}): Promise<{ readonly body: unknown; readonly statusCode: number }> {
	const handler = createGatewayControlAdmissionPressureE2eRequestHandler();
	if (handler === undefined) throw new Error('Expected pressure route handler.');
	const request = Readable.from([Buffer.from(options.bodyText)]) as Readable & {
		headers: Readonly<Record<string, string>>;
		method: string;
	};
	request.method = options.method ?? 'POST';
	request.headers =
		options.signature === undefined
			? {}
			: { [GATEWAY_CONTROL_ADMISSION_PRESSURE_E2E_SIGNATURE_HEADER]: options.signature };
	let responseText = '';
	let statusCode = 200;
	const finished = new Promise<void>((resolve) => {
		const response = {
			end: (chunk?: string | Buffer): void => {
				responseText = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : (chunk ?? '');
				resolve();
			},
			setHeader: vi.fn(),
			get statusCode(): number {
				return statusCode;
			},
			set statusCode(value: number) {
				statusCode = value;
			},
		};
		handler(request as never, response as unknown as Parameters<NonNullable<typeof handler>>[1]);
	});
	await finished;
	return { body: JSON.parse(responseText) as unknown, statusCode };
}

afterEach(() => {
	unregisterActuator?.();
	unregisterActuator = undefined;
	vi.unstubAllEnvs();
});

describe('Gateway Runtime control admission pressure E2E route', () => {
	it('is absent without the explicit gate and requires a dedicated signing key', () => {
		expect(createGatewayControlAdmissionPressureE2eRequestHandler()).toBeUndefined();
		vi.stubEnv(AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_ENV, '1');
		expect(() => createGatewayControlAdmissionPressureE2eRequestHandler()).toThrow(
			'signing key is required',
		);
		expect(GATEWAY_CONTROL_ADMISSION_PRESSURE_E2E_PATH).toBe(
			'/__agent-vm/e2e/control-admission-pressure',
		);
	});

	it('dispatches a signed snapshot to the registered Gateway Runtime actuator', async () => {
		enableRoute();
		const snapshot = vi.fn(() => ({ acceptedAttachmentGeneration: 7 }));
		unregisterActuator = registerGatewayControlAdmissionPressureE2eActuator({
			hold: vi.fn(async () => ({ holdId: 'hold-a' })),
			release: vi.fn(async () => undefined),
			snapshot: snapshot as never,
			submitBatch: vi.fn(async () => ({ admissions: [], snapshot: {} as never })),
		});
		const bodyText = JSON.stringify({
			action: 'snapshot',
			attachmentGeneration: 7,
			scenario: 'control-admission-pressure',
		});
		const result = await invokeHandler({
			bodyText,
			signature: gatewayControlAdmissionPressureE2eRouteTestExports.signBody(bodyText, signingKey),
		});
		expect(result).toEqual({
			body: { details: { acceptedAttachmentGeneration: 7 }, ok: true },
			statusCode: 200,
		});
		expect(snapshot).toHaveBeenCalledWith(7);
	});

	it('rejects unsigned, wrong-method, oversized, and unsupported requests', async () => {
		enableRoute();
		const snapshot = vi.fn();
		unregisterActuator = registerGatewayControlAdmissionPressureE2eActuator({
			hold: vi.fn(async () => ({ holdId: 'hold-a' })),
			release: vi.fn(async () => undefined),
			snapshot: snapshot as never,
			submitBatch: vi.fn(async () => ({ admissions: [], snapshot: {} as never })),
		});
		const snapshotBody = JSON.stringify({
			action: 'snapshot',
			attachmentGeneration: 7,
			scenario: 'control-admission-pressure',
		});

		expect((await invokeHandler({ bodyText: snapshotBody })).statusCode).toBe(401);
		expect(
			(
				await invokeHandler({
					bodyText: snapshotBody,
					method: 'GET',
					signature: gatewayControlAdmissionPressureE2eRouteTestExports.signBody(
						snapshotBody,
						signingKey,
					),
				})
			).statusCode,
		).toBe(405);
		expect((await invokeHandler({ bodyText: 'x'.repeat(16 * 1024 + 1) })).statusCode).toBe(413);
		const unsupportedBody = JSON.stringify({
			action: 'replace-runtime',
			attachmentGeneration: 7,
			scenario: 'control-admission-pressure',
		});
		expect(
			(
				await invokeHandler({
					bodyText: unsupportedBody,
					signature: gatewayControlAdmissionPressureE2eRouteTestExports.signBody(
						unsupportedBody,
						signingKey,
					),
				})
			).statusCode,
		).toBe(400);
		expect(snapshot).not.toHaveBeenCalled();
	});
});
