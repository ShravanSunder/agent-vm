import type { ResolvedMcpPortalProfile } from '@agent-vm/config-contracts';
import { describe, expect, it } from 'vitest';

import type { PortalToolRecord } from '../catalog-types.js';
import type { JsonObject } from '../json-schema.js';
import { hashCallArguments, signApprovalToken } from '../portal-auth/hmac-token.js';
import { createPortalPolicyApprovalEvaluator } from './portal-approval-evaluator.js';
import type { PortalApprovalCall } from './portal-tools.js';

const hmacKey = Buffer.from('00'.repeat(32), 'hex');

const profile = {
	approval: {
		allowWithoutApprovalTools: [{ namespace: 'linear', toolName: 'list_issues' }],
		alwaysAskTools: [{ namespace: 'linear', toolName: 'create_issue' }],
		annotationPolicy: 'destructive-requires-approval',
		callPoliciesByNamespace: {},
		trustedAnnotationNamespaces: [],
		writeTools: [],
	},
	cache: { catalogTtlMs: 60_000 },
	enabledNamespaces: ['linear'],
	enabledToolsByNamespace: {},
	hiddenToolsByNamespace: {},
	logging: { enabled: false },
	promptContext: { enabled: true, maxNamespaces: 12 },
} satisfies ResolvedMcpPortalProfile;

function createTool(namespace: string, toolName: string): PortalToolRecord {
	return {
		inputSchema: { type: 'object' },
		namespace,
		toolName,
	};
}

function createCall(props: {
	readonly arguments?: JsonObject;
	readonly id: string;
	readonly namespace: string;
	readonly toolName: string;
}): PortalApprovalCall {
	return {
		arguments: props.arguments ?? {},
		id: props.id,
		namespace: props.namespace,
		tool: createTool(props.namespace, props.toolName),
		toolName: props.toolName,
	};
}

const listIssuesCall = createCall({
	id: 'list',
	namespace: 'linear',
	toolName: 'list_issues',
});

const createIssueCall = createCall({
	arguments: { title: 'Fix deploy' },
	id: 'create',
	namespace: 'linear',
	toolName: 'create_issue',
});

const createIssueDigest = {
	argumentsHash: hashCallArguments(createIssueCall.arguments),
	namespace: createIssueCall.namespace,
	toolName: createIssueCall.toolName,
};

describe('createPortalPolicyApprovalEvaluator', () => {
	it('defaults missing approval tokens to token-missing for proxy callers', () => {
		const evaluateApproval = createPortalPolicyApprovalEvaluator({
			resolveRecord: () => ({ hmacKey, profile }),
		});

		expect(evaluateApproval([listIssuesCall, createIssueCall], 'agent-a', undefined)).toEqual({
			decisionsByCallId: {
				create: { kind: 'approval_token_missing' },
				list: { kind: 'allow' },
			},
		});
	});

	it('can surface missing approval tokens as approval-required for OpenClaw native callers', () => {
		const evaluateApproval = createPortalPolicyApprovalEvaluator({
			missingApprovalTokenDecision: { kind: 'approval_required', level: 'standard' },
			resolveRecord: () => ({ hmacKey, profile }),
		});

		expect(evaluateApproval([listIssuesCall, createIssueCall], 'agent-a', undefined)).toEqual({
			decisionsByCallId: {
				create: { kind: 'approval_required', level: 'standard' },
				list: { kind: 'allow' },
			},
		});
	});

	it('rejects replayed approval tokens through the shared evaluator', () => {
		const consumed = new Set<string>();
		const evaluateApproval = createPortalPolicyApprovalEvaluator({
			consumeTokenId: (_agentId, jti) => {
				if (consumed.has(jti)) {
					return { ok: false, reason: 'replayed' };
				}
				consumed.add(jti);
				return { ok: true };
			},
			nowMs: () => 1_000,
			resolveRecord: () => ({ hmacKey, profile }),
		});
		const token = signApprovalToken({
			agentId: 'agent-a',
			calls: [createIssueDigest],
			expiresAtMs: 61_000,
			issuedAtMs: 1_000,
			key: hmacKey,
		});

		expect(
			evaluateApproval([createIssueCall], 'agent-a', token).decisionsByCallId['create'],
		).toEqual({
			kind: 'allow',
		});
		expect(
			evaluateApproval([createIssueCall], 'agent-a', token).decisionsByCallId['create'],
		).toEqual({
			kind: 'approval_token_invalid',
			reason: 'replayed',
		});
	});
});
