import { createHmac, timingSafeEqual } from 'node:crypto';

import {
	AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_IDENTITIES_ENV,
	AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_KEY_ENV,
} from '../gateway-runtime-sandbox-write-read-e2e-route.js';
import type { OpenClawHttpRouteRegistrationApi } from '../openclaw-sandbox-sdk-contract.js';
import {
	AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_ENV,
	GATEWAY_CONTROL_ADMISSION_PRESSURE_BATCH_LIMIT,
	getGatewayControlAdmissionPressureE2eActuator,
} from './gateway-control-admission-pressure-e2e-testing.js';

export const AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_PATH =
	'/plugins/gondolin/e2e/control-admission-pressure';
export const AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_SIGNATURE_HEADER =
	'x-agent-vm-e2e-control-admission-pressure-signature';

const maximumBodyBytes = 16 * 1024;

interface ConfiguredIdentity {
	readonly agentId: string;
	readonly sessionKey: string;
}

type PressureRouteParams =
	| { readonly action: 'snapshot'; readonly attachmentGeneration: number }
	| {
			readonly action: 'hold';
			readonly attachmentGeneration: number;
			readonly direction: 'egress' | 'ingress';
			readonly messageClass: 'diagnostic' | 'liveness';
	  }
	| {
			readonly action: 'release';
			readonly attachmentGeneration: number;
			readonly holdId: string;
	  }
	| {
			readonly action: 'submitBatch';
			readonly attachmentGeneration: number;
			readonly batchSize: number;
			readonly byteLength: number;
			readonly coalesceKeyPrefix: string;
			readonly direction: 'egress' | 'ingress';
			readonly messageClass: 'diagnostic' | 'liveness';
	  };

class ControlAdmissionPressureRouteError extends Error {
	readonly statusCode: number;

	constructor(message: string, statusCode: number) {
		super(message);
		this.name = 'ControlAdmissionPressureRouteError';
		this.statusCode = statusCode;
	}
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readConfiguredIdentities(): readonly ConfiguredIdentity[] {
	const serialized = process.env[AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_IDENTITIES_ENV];
	if (serialized === undefined) {
		throw new Error('control-admission-pressure-e2e: configured identities are required.');
	}
	const parsed: unknown = JSON.parse(serialized);
	if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 8) {
		throw new Error('control-admission-pressure-e2e: configured identities are malformed.');
	}
	return parsed.map((identity) => {
		if (
			!isObjectRecord(identity) ||
			Object.keys(identity).toSorted().join(',') !== 'agentId,sessionKey' ||
			typeof identity.agentId !== 'string' ||
			identity.agentId.length === 0 ||
			typeof identity.sessionKey !== 'string' ||
			identity.sessionKey.length === 0
		) {
			throw new Error('control-admission-pressure-e2e: configured identity is malformed.');
		}
		return { agentId: identity.agentId, sessionKey: identity.sessionKey };
	});
}

function requireConfiguredIdentity(
	params: Readonly<Record<string, unknown>>,
	identities: readonly ConfiguredIdentity[],
): void {
	if (
		typeof params.agentId !== 'string' ||
		typeof params.sessionKey !== 'string' ||
		!identities.some(
			(identity) =>
				identity.agentId === params.agentId && identity.sessionKey === params.sessionKey,
		)
	) {
		throw new ControlAdmissionPressureRouteError(
			'control-admission-pressure-e2e: request identity is not configured.',
			403,
		);
	}
}

function requirePositiveInteger(
	params: Readonly<Record<string, unknown>>,
	fieldName: 'attachmentGeneration' | 'batchSize' | 'byteLength',
): number {
	const value = params[fieldName];
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
		throw new ControlAdmissionPressureRouteError(
			`control-admission-pressure-e2e: ${fieldName} must be a positive safe integer.`,
			400,
		);
	}
	return value;
}

function parseParams(
	value: unknown,
	identities: readonly ConfiguredIdentity[],
): PressureRouteParams {
	if (!isObjectRecord(value) || value.scenario !== 'control-admission-pressure') {
		throw new ControlAdmissionPressureRouteError(
			'control-admission-pressure-e2e: unsupported request.',
			400,
		);
	}
	requireConfiguredIdentity(value, identities);
	const attachmentGeneration = requirePositiveInteger(value, 'attachmentGeneration');
	if (value.action === 'snapshot') return { action: value.action, attachmentGeneration };
	if (value.action === 'release') {
		if (typeof value.holdId !== 'string' || value.holdId.length === 0) {
			throw new ControlAdmissionPressureRouteError(
				'control-admission-pressure-e2e: holdId is required.',
				400,
			);
		}
		return { action: value.action, attachmentGeneration, holdId: value.holdId };
	}
	if (value.action !== 'hold' && value.action !== 'submitBatch') {
		throw new ControlAdmissionPressureRouteError(
			'control-admission-pressure-e2e: unsupported action.',
			400,
		);
	}
	if (value.direction !== 'egress' && value.direction !== 'ingress') {
		throw new ControlAdmissionPressureRouteError(
			'control-admission-pressure-e2e: unsupported direction.',
			400,
		);
	}
	if (value.messageClass !== 'diagnostic' && value.messageClass !== 'liveness') {
		throw new ControlAdmissionPressureRouteError(
			'control-admission-pressure-e2e: unsupported message class.',
			400,
		);
	}
	if (value.action === 'hold') {
		return {
			action: value.action,
			attachmentGeneration,
			direction: value.direction,
			messageClass: value.messageClass,
		};
	}
	const batchSize = requirePositiveInteger(value, 'batchSize');
	if (batchSize > GATEWAY_CONTROL_ADMISSION_PRESSURE_BATCH_LIMIT) {
		throw new ControlAdmissionPressureRouteError(
			'control-admission-pressure-e2e: batchSize exceeds the test limit.',
			400,
		);
	}
	const byteLength = requirePositiveInteger(value, 'byteLength');
	if (typeof value.coalesceKeyPrefix !== 'string' || value.coalesceKeyPrefix.length === 0) {
		throw new ControlAdmissionPressureRouteError(
			'control-admission-pressure-e2e: coalesceKeyPrefix is required.',
			400,
		);
	}
	return {
		action: value.action,
		attachmentGeneration,
		batchSize,
		byteLength,
		coalesceKeyPrefix: value.coalesceKeyPrefix,
		direction: value.direction,
		messageClass: value.messageClass,
	};
}

async function runAction(params: PressureRouteParams): Promise<unknown> {
	const actuator = getGatewayControlAdmissionPressureE2eActuator();
	if (actuator === undefined) {
		throw new ControlAdmissionPressureRouteError(
			'control-admission-pressure-e2e: actuator is unavailable.',
			503,
		);
	}
	try {
		switch (params.action) {
			case 'hold':
				return await actuator.hold(params);
			case 'release':
				await actuator.release(params);
				return { released: true };
			case 'snapshot':
				return actuator.snapshot(params.attachmentGeneration);
			case 'submitBatch':
				return await actuator.submitBatch(params);
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ControlAdmissionPressureRouteError(message, message.includes('stale') ? 409 : 500);
	}
}

async function readBody(request: AsyncIterable<Buffer | string>): Promise<string> {
	const chunks: Buffer[] = [];
	let byteLength = 0;
	for await (const chunk of request) {
		const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
		byteLength += bytes.byteLength;
		if (byteLength > maximumBodyBytes) {
			throw new ControlAdmissionPressureRouteError(
				'control-admission-pressure-e2e: body is too large.',
				413,
			);
		}
		chunks.push(bytes);
	}
	return Buffer.concat(chunks).toString('utf8');
}

function verifySignature(bodyText: string, signature: string | undefined, key: string): void {
	if (signature === undefined) {
		throw new ControlAdmissionPressureRouteError(
			'control-admission-pressure-e2e: signature is required.',
			401,
		);
	}
	const expected = Buffer.from(createHmac('sha256', key).update(bodyText).digest('base64url'));
	const received = Buffer.from(signature);
	if (expected.byteLength !== received.byteLength || !timingSafeEqual(expected, received)) {
		throw new ControlAdmissionPressureRouteError(
			'control-admission-pressure-e2e: signature is invalid.',
			403,
		);
	}
}

function headerValue(
	headers: Readonly<Record<string, string | readonly string[] | undefined>>,
	name: string,
): string | undefined {
	const value = headers[name];
	return typeof value === 'string' ? value : undefined;
}

export function registerGatewayControlAdmissionPressureE2eRoute(options: {
	readonly api: OpenClawHttpRouteRegistrationApi;
}): void {
	if (process.env[AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_ENV] !== '1') return;
	const key = process.env[AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_KEY_ENV];
	if (key === undefined || key.length === 0) {
		throw new Error('control-admission-pressure-e2e: signing key is required.');
	}
	const identities = readConfiguredIdentities();
	options.api.registerHttpRoute?.({
		auth: 'plugin',
		handler: async (request, response) => {
			try {
				if (request.method !== 'POST') {
					throw new ControlAdmissionPressureRouteError(
						'control-admission-pressure-e2e: method must be POST.',
						405,
					);
				}
				const bodyText = await readBody(request);
				verifySignature(
					bodyText,
					headerValue(request.headers, AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_SIGNATURE_HEADER),
					key,
				);
				const details = await runAction(parseParams(JSON.parse(bodyText) as unknown, identities));
				response.statusCode = 200;
				response.setHeader('cache-control', 'no-store');
				response.setHeader('content-type', 'application/json; charset=utf-8');
				response.end(JSON.stringify({ details, ok: true }));
			} catch (error: unknown) {
				const routeError = error instanceof ControlAdmissionPressureRouteError ? error : undefined;
				response.statusCode = routeError?.statusCode ?? 400;
				response.setHeader('cache-control', 'no-store');
				response.setHeader('content-type', 'application/json; charset=utf-8');
				response.end(
					JSON.stringify({
						error: {
							message:
								routeError?.message ?? 'control-admission-pressure-e2e: request is malformed.',
						},
						ok: false,
					}),
				);
			}
			return true;
		},
		match: 'exact',
		path: AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_PATH,
	});
}

export const gatewayControlAdmissionPressureE2eRouteTestExports = {
	signBody(bodyText: string, key: string): string {
		return createHmac('sha256', key).update(bodyText).digest('base64url');
	},
};
