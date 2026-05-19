import { describe, expect, it } from 'vitest';

import { hashCallArguments, signApprovalToken } from '../auth/hmac-token.js';
import type { PortalToolRecord } from '../catalog-types.js';
import type { JsonObject } from '../json-schema.js';
import {
	createPortalApprovalVerifier,
	type PortalAgentRuntimeRecord,
} from './resolve-agent-identity.js';

const hmacKey = Buffer.from('00'.repeat(32), 'hex');

const profile: PortalAgentRuntimeRecord['profile'] = {
	approval: {
		allowWithoutApprovalTools: [],
		alwaysAskTools: [],
		annotationPolicy: 'destructive-requires-approval',
		trustedAnnotationNamespaces: ['linear'],
		writeTools: [],
	},
	cache: { catalogTtlMs: 60_000 },
	enabledNamespaces: ['linear', 'github'],
	enabledToolsByNamespace: {},
	hiddenToolsByNamespace: {},
	logging: { enabled: false },
	promptContext: { enabled: true, maxNamespaces: 12 },
};

function createVerifier(): ReturnType<typeof createPortalApprovalVerifier> {
	return createPortalApprovalVerifier({
		records: new Map<string, PortalAgentRuntimeRecord>([
			[
				'shravan',
				{
					agentId: 'shravan',
					hmacKey,
					profile,
					profileName: 'builder',
				},
			],
		]),
	});
}

function createTool(
	namespace: string,
	toolName: string,
	annotations?: PortalToolRecord['annotations'],
): PortalToolRecord {
	return {
		annotations,
		inputSchema: { type: 'object' },
		namespace,
		toolName,
	};
}

function createCall(props: {
	readonly annotations?: PortalToolRecord['annotations'];
	readonly arguments?: JsonObject;
	readonly namespace: string;
	readonly toolName: string;
}): Parameters<ReturnType<typeof createPortalApprovalVerifier>>[0][number] {
	return {
		arguments: props.arguments ?? {},
		id: `${props.namespace}.${props.toolName}`,
		namespace: props.namespace,
		tool: createTool(props.namespace, props.toolName, props.annotations),
		toolName: props.toolName,
	};
}

describe('createPortalApprovalVerifier', () => {
	it('fails closed for untrusted tools and trusted tools without annotations', () => {
		const verifier = createVerifier();

		expect(
			verifier(
				[
					createCall({
						namespace: 'github',
						toolName: 'delete_issue',
					}),
				],
				'shravan',
				undefined,
			),
		).toEqual({ kind: 'approval_token_missing' });
		expect(
			verifier(
				[
					createCall({
						namespace: 'linear',
						toolName: 'list_issues',
					}),
				],
				'shravan',
				undefined,
			),
		).toEqual({ kind: 'approval_token_missing' });
	});

	it('allows trusted explicitly read-only tools without a token', () => {
		const verifier = createVerifier();

		expect(
			verifier(
				[
					createCall({
						annotations: { destructiveHint: false, readOnlyHint: true },
						namespace: 'linear',
						toolName: 'list_issues',
					}),
				],
				'shravan',
				undefined,
			),
		).toEqual({ kind: 'allow' });
	});

	it('rejects tokens that only match the conservative approval set', () => {
		const verifier = createVerifier();
		const readOnlyArguments = { query: 'deploy' };
		const writeArguments = { id: 'ISSUE-1' };
		const calls = [
			createCall({
				annotations: { destructiveHint: false, readOnlyHint: true },
				arguments: readOnlyArguments,
				namespace: 'linear',
				toolName: 'list_issues',
			}),
			createCall({
				arguments: writeArguments,
				namespace: 'github',
				toolName: 'delete_issue',
			}),
		];
		const token = signApprovalToken({
			agentId: 'shravan',
			calls: calls.map((call) => ({
				argumentsHash: hashCallArguments(call.arguments),
				namespace: call.namespace,
				toolName: call.toolName,
			})),
			expiresAtMs: Date.now() + 60_000,
			key: hmacKey,
		});

		expect(verifier(calls, 'shravan', token)).toEqual({
			kind: 'approval_token_invalid',
			reason: 'call-mismatch',
		});
	});

	it('rejects conservative fallback even when no audit callback is registered', () => {
		const verifier = createPortalApprovalVerifier({
			records: new Map<string, PortalAgentRuntimeRecord>([
				[
					'shravan',
					{
						agentId: 'shravan',
						hmacKey,
						profile,
						profileName: 'builder',
					},
				],
			]),
		});
		const calls = [
			createCall({
				annotations: { destructiveHint: false, readOnlyHint: true },
				arguments: { query: 'deploy' },
				namespace: 'linear',
				toolName: 'list_issues',
			}),
			createCall({
				arguments: { id: 'ISSUE-1' },
				namespace: 'github',
				toolName: 'delete_issue',
			}),
		];
		const token = signApprovalToken({
			agentId: 'shravan',
			calls: calls.map((call) => ({
				argumentsHash: hashCallArguments(call.arguments),
				namespace: call.namespace,
				toolName: call.toolName,
			})),
			expiresAtMs: Date.now() + 60_000,
			key: hmacKey,
		});

		expect(verifier(calls, 'shravan', token)).toEqual({
			kind: 'approval_token_invalid',
			reason: 'call-mismatch',
		});
	});

	it('rejects invalid approval tokens with the verifier reason', () => {
		const verifier = createVerifier();

		expect(
			verifier(
				[
					createCall({
						namespace: 'github',
						toolName: 'delete_issue',
					}),
				],
				'shravan',
				'not.a.real.token',
			),
		).toEqual({ kind: 'approval_token_invalid', reason: 'malformed' });
	});
});
