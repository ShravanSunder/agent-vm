import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
	AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_ENV,
	AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_KEY_ENV,
	GATEWAY_CONTROL_ADMISSION_PRESSURE_BATCH_LIMIT,
	getGatewayControlAdmissionPressureE2eActuator,
} from './gateway-control-admission-pressure-e2e-testing.js';

export const GATEWAY_CONTROL_ADMISSION_PRESSURE_E2E_PATH =
	'/__agent-vm/e2e/control-admission-pressure';
export const GATEWAY_CONTROL_ADMISSION_PRESSURE_E2E_SIGNATURE_HEADER =
	'x-agent-vm-e2e-control-admission-pressure-signature';

const maximumBodyBytes = 16 * 1024;

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

export type GatewayControlAdmissionPressureE2eRequestHandler = (
	request: IncomingMessage,
	response: ServerResponse,
) => void;

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

function requireExactKeys(
	params: Readonly<Record<string, unknown>>,
	expectedKeys: readonly string[],
): void {
	if (Object.keys(params).toSorted().join(',') !== [...expectedKeys].toSorted().join(',')) {
		throw new ControlAdmissionPressureRouteError(
			'control-admission-pressure-e2e: request contains unsupported fields.',
			400,
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

function parseParams(value: unknown): PressureRouteParams {
	if (!isObjectRecord(value) || value.scenario !== 'control-admission-pressure') {
		throw new ControlAdmissionPressureRouteError(
			'control-admission-pressure-e2e: unsupported request.',
			400,
		);
	}
	const attachmentGeneration = requirePositiveInteger(value, 'attachmentGeneration');
	if (value.action === 'snapshot') {
		requireExactKeys(value, ['action', 'attachmentGeneration', 'scenario']);
		return { action: value.action, attachmentGeneration };
	}
	if (value.action === 'release') {
		requireExactKeys(value, ['action', 'attachmentGeneration', 'holdId', 'scenario']);
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
		requireExactKeys(value, [
			'action',
			'attachmentGeneration',
			'direction',
			'messageClass',
			'scenario',
		]);
		return {
			action: value.action,
			attachmentGeneration,
			direction: value.direction,
			messageClass: value.messageClass,
		};
	}
	requireExactKeys(value, [
		'action',
		'attachmentGeneration',
		'batchSize',
		'byteLength',
		'coalesceKeyPrefix',
		'direction',
		'messageClass',
		'scenario',
	]);
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
		throw new Error('control-admission-pressure-e2e: unreachable action.');
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ControlAdmissionPressureRouteError(message, message.includes('stale') ? 409 : 500);
	}
}

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let byteLength = 0;
	for await (const chunk of request) {
		const unknownChunk: unknown = chunk;
		if (typeof unknownChunk !== 'string' && !Buffer.isBuffer(unknownChunk)) {
			throw new ControlAdmissionPressureRouteError(
				'control-admission-pressure-e2e: body contains an unsupported chunk.',
				400,
			);
		}
		const bytes = typeof unknownChunk === 'string' ? Buffer.from(unknownChunk) : unknownChunk;
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

function writeJsonResponse(response: ServerResponse, statusCode: number, body: unknown): void {
	response.statusCode = statusCode;
	response.setHeader('cache-control', 'no-store');
	response.setHeader('content-type', 'application/json; charset=utf-8');
	response.end(JSON.stringify(body));
}

export function createGatewayControlAdmissionPressureE2eRequestHandler():
	| GatewayControlAdmissionPressureE2eRequestHandler
	| undefined {
	if (process.env[AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_ENV] !== '1') return undefined;
	const key = process.env[AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_KEY_ENV];
	if (key === undefined || key.length === 0) {
		throw new Error('control-admission-pressure-e2e: signing key is required.');
	}
	return (request, response): void => {
		void (async () => {
			try {
				if (request.method !== 'POST') {
					throw new ControlAdmissionPressureRouteError(
						'control-admission-pressure-e2e: method must be POST.',
						405,
					);
				}
				const bodyText = await readBody(request);
				const signature = request.headers[GATEWAY_CONTROL_ADMISSION_PRESSURE_E2E_SIGNATURE_HEADER];
				verifySignature(bodyText, typeof signature === 'string' ? signature : undefined, key);
				const details = await runAction(parseParams(JSON.parse(bodyText) as unknown));
				writeJsonResponse(response, 200, { details, ok: true });
			} catch (error: unknown) {
				const routeError = error instanceof ControlAdmissionPressureRouteError ? error : undefined;
				writeJsonResponse(response, routeError?.statusCode ?? 400, {
					error: {
						message: routeError?.message ?? 'control-admission-pressure-e2e: request is malformed.',
					},
					ok: false,
				});
			}
		})();
	};
}

export const gatewayControlAdmissionPressureE2eRouteTestExports = {
	signBody(bodyText: string, key: string): string {
		return createHmac('sha256', key).update(bodyText).digest('base64url');
	},
};
