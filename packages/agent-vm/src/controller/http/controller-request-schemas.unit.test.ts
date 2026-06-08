import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	controllerLeaseCreateRequestSchema,
	controllerPullDefaultResponseSchema,
} from './controller-request-schemas.js';

describe('controller request schemas', () => {
	it('converts the production lease create request schema with native z.toJSONSchema', () => {
		const jsonSchema = z.toJSONSchema(controllerLeaseCreateRequestSchema, {
			io: 'input',
			target: 'draft-7',
		});

		expect(jsonSchema).toMatchObject({
			additionalProperties: false,
			properties: {
				agentId: { minLength: 1, type: 'string' },
				agentWorkspaceDir: { minLength: 1, type: 'string' },
				idleTtlMs: { exclusiveMinimum: 0, type: 'integer' },
				profileId: { minLength: 1, type: 'string' },
				sessionKey: { minLength: 1, type: 'string' },
				workMountDir: { minLength: 1, type: 'string' },
				zoneId: { minLength: 1, type: 'string' },
			},
			required: [
				'agentId',
				'agentWorkspaceDir',
				'profileId',
				'sessionKey',
				'workMountDir',
				'zoneId',
			],
			type: 'object',
		});
	});

	it('converts the production pull-default response schema with native z.toJSONSchema', () => {
		const jsonSchema = z.toJSONSchema(controllerPullDefaultResponseSchema, {
			io: 'output',
			target: 'draft-7',
		});

		expect(jsonSchema).toMatchObject({
			oneOf: [
				expect.objectContaining({
					properties: expect.objectContaining({
						kind: { const: 'advanced', type: 'string' },
					}),
				}),
				expect.objectContaining({
					properties: expect.objectContaining({
						kind: { const: 'refused-not-fast-forward', type: 'string' },
					}),
				}),
				expect.objectContaining({
					properties: expect.objectContaining({
						kind: { const: 'failed', type: 'string' },
					}),
				}),
			],
		});
	});

	it('rejects deprecated lease scopeKey and sandbox fields', () => {
		const payload = {
			agentId: 'main',
			agentWorkspaceDir: '/zone/agents/main',
			profileId: 'standard',
			scopeKey: 'agent:main',
			sandbox: {
				backend: 'gondolin',
				mode: 'all',
				scope: 'agent',
				workspaceAccess: 'rw',
			},
			sessionKey: 'agent:main:manual',
			workMountDir: '/zone/agents/main',
			zoneId: 'shravan',
		};

		const result = controllerLeaseCreateRequestSchema.safeParse(payload);

		expect(result.success).toBe(false);
		expect(result.success ? [] : result.error.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: 'unrecognized_keys',
					keys: expect.arrayContaining(['scopeKey', 'sandbox']),
				}),
			]),
		);
	});

	it('accepts the hard-cutover agent lease request shape', () => {
		const result = controllerLeaseCreateRequestSchema.safeParse({
			agentId: 'main',
			agentWorkspaceDir: '/zone/agents/main',
			profileId: 'standard',
			sessionKey: 'agent:main:manual',
			workMountDir: '/zone/agents/main',
			zoneId: 'shravan',
		});

		expect(result.success).toBe(true);
	});

	it('rejects non-absolute and parent-traversing lease path fields', () => {
		const validLeaseRequest = {
			agentId: 'main',
			agentWorkspaceDir: '/home/openclaw/work',
			profileId: 'standard',
			sessionKey: 'agent:main:session-abc',
			workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
			zoneId: 'shravan',
		};

		expect(
			controllerLeaseCreateRequestSchema.safeParse({
				...validLeaseRequest,
				agentWorkspaceDir: '../agent',
			}).success,
		).toBe(false);
		expect(
			controllerLeaseCreateRequestSchema.safeParse({
				...validLeaseRequest,
				agentWorkspaceDir: '/home/openclaw/../agent',
			}).success,
		).toBe(false);
		expect(
			controllerLeaseCreateRequestSchema.safeParse({
				...validLeaseRequest,
				agentWorkspaceDir: '/',
			}).success,
		).toBe(false);
		expect(
			controllerLeaseCreateRequestSchema.safeParse({
				...validLeaseRequest,
				workMountDir: 'relative/work',
			}).success,
		).toBe(false);
		expect(
			controllerLeaseCreateRequestSchema.safeParse({
				...validLeaseRequest,
				workMountDir: '/home/openclaw/../work',
			}).success,
		).toBe(false);
	});
});
