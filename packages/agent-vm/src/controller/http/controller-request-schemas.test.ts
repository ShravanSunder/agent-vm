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
				profileId: { minLength: 1, type: 'string' },
				sandbox: expect.objectContaining({
					properties: expect.objectContaining({
						backend: { type: 'string' },
						mode: { type: 'string' },
						scope: { type: 'string' },
						workspaceAccess: { type: 'string' },
					}),
					required: ['backend', 'mode', 'scope', 'workspaceAccess'],
					type: 'object',
				}),
				scopeKey: { minLength: 1, type: 'string' },
				sessionKey: { minLength: 1, type: 'string' },
				workMountDir: { minLength: 1, type: 'string' },
				zoneId: { minLength: 1, type: 'string' },
			},
			required: [
				'agentId',
				'agentWorkspaceDir',
				'profileId',
				'sandbox',
				'scopeKey',
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

	it('rejects non-absolute and parent-traversing lease agent workspace paths', () => {
		const validLeaseRequest = {
			agentId: 'main',
			agentWorkspaceDir: '/home/openclaw/work',
			profileId: 'standard',
			sandbox: {
				backend: 'gondolin',
				mode: 'all',
				scope: 'agent',
				workspaceAccess: 'rw',
			},
			scopeKey: 'agent:main',
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
	});
});
