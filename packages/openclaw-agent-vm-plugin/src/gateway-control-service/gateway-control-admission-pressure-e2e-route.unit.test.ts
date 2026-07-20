import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_IDENTITIES_ENV,
	AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_KEY_ENV,
} from '../gateway-runtime-sandbox-write-read-e2e-route.js';
import type { OpenClawHttpRouteRegistration } from '../openclaw-sandbox-sdk-contract.js';
import {
	AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_PATH,
	AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_SIGNATURE_HEADER,
	gatewayControlAdmissionPressureE2eRouteTestExports,
	registerGatewayControlAdmissionPressureE2eRoute,
} from './gateway-control-admission-pressure-e2e-route.js';
import {
	AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_ENV,
	registerGatewayControlAdmissionPressureE2eActuator,
} from './gateway-control-admission-pressure-e2e-testing.js';

const key = 'control-admission-pressure-route-key';
const identity = {
	agentId: 'main',
	sessionKey: 'agent:main:control-admission-pressure',
} as const;

function enableRoute(): void {
	vi.stubEnv(AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_ENV, '1');
	vi.stubEnv(AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_KEY_ENV, key);
	vi.stubEnv(AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_IDENTITIES_ENV, JSON.stringify([identity]));
}

function registerRoute(): OpenClawHttpRouteRegistration {
	const registerHttpRoute = vi.fn();
	registerGatewayControlAdmissionPressureE2eRoute({ api: { registerHttpRoute } });
	const route = registerHttpRoute.mock.calls[0]?.[0] as OpenClawHttpRouteRegistration | undefined;
	if (route === undefined) throw new Error('Expected the control-pressure E2E route to register.');
	return route;
}

async function invokeRoute(options: {
	readonly bodyText: string;
	readonly route: OpenClawHttpRouteRegistration;
	readonly signature?: string;
}): Promise<{ readonly body: unknown; readonly statusCode: number }> {
	const request = Readable.from([Buffer.from(options.bodyText)]) as Readable & {
		headers: Readonly<Record<string, string>>;
		method: string;
	};
	request.method = 'POST';
	request.headers =
		options.signature === undefined
			? {}
			: { [AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_SIGNATURE_HEADER]: options.signature };
	let responseText = '';
	let statusCode = 200;
	const response = {
		end: (chunk?: string | Buffer): void => {
			responseText = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : (chunk ?? '');
		},
		setHeader: vi.fn(),
		get statusCode(): number {
			return statusCode;
		},
		set statusCode(value: number) {
			statusCode = value;
		},
	};
	await options.route.handler(
		request as Parameters<OpenClawHttpRouteRegistration['handler']>[0],
		response as unknown as Parameters<OpenClawHttpRouteRegistration['handler']>[1],
	);
	return { body: JSON.parse(responseText) as unknown, statusCode };
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('Gateway control admission pressure E2E route', () => {
	it('registers only behind the existing pressure E2E opt-in on its own path', () => {
		const registerHttpRoute = vi.fn();
		registerGatewayControlAdmissionPressureE2eRoute({ api: { registerHttpRoute } });
		expect(registerHttpRoute).not.toHaveBeenCalled();

		enableRoute();
		registerGatewayControlAdmissionPressureE2eRoute({ api: { registerHttpRoute } });
		expect(registerHttpRoute).toHaveBeenCalledWith(
			expect.objectContaining({
				auth: 'plugin',
				match: 'exact',
				path: AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_PATH,
			}),
		);
	});

	it('dispatches a signed configured-identity snapshot to the existing actuator', async () => {
		enableRoute();
		const snapshot = vi.fn(() => ({ acceptedAttachmentGeneration: 7 }));
		registerGatewayControlAdmissionPressureE2eActuator({
			hold: vi.fn(async () => ({ holdId: 'hold-a' })),
			release: vi.fn(async () => undefined),
			snapshot: snapshot as never,
			submitBatch: vi.fn(async () => ({ admissions: [], snapshot: {} as never })),
		});
		const route = registerRoute();
		const bodyText = JSON.stringify({
			action: 'snapshot',
			...identity,
			attachmentGeneration: 7,
			scenario: 'control-admission-pressure',
		});
		const result = await invokeRoute({
			bodyText,
			route,
			signature: gatewayControlAdmissionPressureE2eRouteTestExports.signBody(bodyText, key),
		});
		expect(result).toEqual({
			body: { details: { acceptedAttachmentGeneration: 7 }, ok: true },
			statusCode: 200,
		});
		expect(snapshot).toHaveBeenCalledWith(7);
	});

	it('rejects unsigned pressure requests before actuator dispatch', async () => {
		enableRoute();
		const snapshot = vi.fn();
		registerGatewayControlAdmissionPressureE2eActuator({
			hold: vi.fn(async () => ({ holdId: 'hold-a' })),
			release: vi.fn(async () => undefined),
			snapshot: snapshot as never,
			submitBatch: vi.fn(async () => ({ admissions: [], snapshot: {} as never })),
		});
		const route = registerRoute();
		const result = await invokeRoute({
			bodyText: JSON.stringify({
				action: 'snapshot',
				...identity,
				attachmentGeneration: 7,
				scenario: 'control-admission-pressure',
			}),
			route,
		});
		expect(result.statusCode).toBe(401);
		expect(snapshot).not.toHaveBeenCalled();
	});
});
