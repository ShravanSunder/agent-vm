import {
	resolveMcpPortalProfile,
	type McpPortalAgentConfig,
	type McpPortalConfig,
	type ResolvedMcpPortalProfile,
	type SecretValue,
} from '@agent-vm/config-contracts';

import { createPortalPolicyApprovalEvaluator } from '../core/portal-approval-evaluator.js';
import type {
	PortalApprovalCall,
	PortalApprovalCallDecision,
	PortalApprovalEvaluation,
} from '../core/portal-tools.js';
import { createPortalAgentIdentity } from '../portal-access-policy.js';

const approvalTokenMaxLifetimeMs = 5 * 60_000;
const approvalTokenReplayCacheLimit = 4_096;

export interface ResolveAgentHmacKeysProps {
	readonly agents: Readonly<Record<string, McpPortalAgentConfig>>;
	readonly envKeys: ReadonlyMap<string, Buffer>;
	readonly resolveSecret: (secret: SecretValue) => Promise<string>;
}

export interface PortalAgentRuntimeRecord {
	readonly agentId: string;
	readonly hmacKey: Buffer;
	readonly profile: ResolvedMcpPortalProfile;
	readonly profileName: string;
}

export interface PortalApprovalAuditEvent {
	readonly agentId: string;
	readonly decision: 'allow' | 'deny';
	readonly kind: 'mcp_portal_approval';
	readonly reason?:
		| 'approval_token_invalid'
		| 'approval_token_missing'
		| 'call_blocked'
		| 'no_approval_required'
		| 'per_call_evaluation';
	readonly timeMs: number;
	readonly verifierReason?: string;
}

async function resolveAgentHmacKeyEntry(props: {
	readonly agent: McpPortalAgentConfig;
	readonly agentId: string;
	readonly envKeys: ReadonlyMap<string, Buffer>;
	readonly resolveSecret: (secret: SecretValue) => Promise<string>;
}): Promise<readonly [string, Buffer]> {
	const envKey = props.envKeys.get(props.agentId);
	if (envKey !== undefined) {
		return [props.agentId, envKey];
	}
	if (props.agent.hmacKey === undefined) {
		throw new Error(`Missing HMAC key for MCP Portal agent "${props.agentId}".`);
	}
	const secretValue = await props.resolveSecret(props.agent.hmacKey);
	if (!/^[0-9a-f]+$/u.test(secretValue) || secretValue.length !== 64) {
		throw new Error(`MCP Portal agent "${props.agentId}" HMAC key must be 64 hex characters.`);
	}
	return [props.agentId, Buffer.from(secretValue, 'hex')];
}

export async function resolveAgentHmacKeys(
	props: ResolveAgentHmacKeysProps,
): Promise<ReadonlyMap<string, Buffer>> {
	return new Map(
		await Promise.all(
			Object.entries(props.agents).map(([agentId, agent]) =>
				resolveAgentHmacKeyEntry({
					agent,
					agentId,
					envKeys: props.envKeys,
					resolveSecret: props.resolveSecret,
				}),
			),
		),
	);
}

export function createPortalAgentRuntimeRecords(props: {
	readonly hmacKeys: ReadonlyMap<string, Buffer>;
	readonly portalConfig: McpPortalConfig;
}): ReadonlyMap<string, PortalAgentRuntimeRecord> {
	const records = new Map<string, PortalAgentRuntimeRecord>();
	for (const [agentId, agent] of Object.entries(props.portalConfig.agents)) {
		const hmacKey = props.hmacKeys.get(agentId);
		if (hmacKey === undefined) {
			throw new Error(`Missing HMAC key for MCP Portal agent "${agentId}".`);
		}
		records.set(agentId, {
			agentId,
			hmacKey,
			profile: resolveMcpPortalProfile(props.portalConfig, agent.profile),
			profileName: agent.profile,
		});
	}
	return records;
}

export function createPortalHttpAgentResolver(
	records: ReadonlyMap<string, PortalAgentRuntimeRecord>,
): (agentId: string) => ReturnType<typeof createPortalAgentIdentity> | null {
	return (agentId) => {
		const record = records.get(agentId);
		if (record === undefined) {
			return null;
		}
		return createPortalAgentIdentity({
			agentId,
			agentScopeId: agentId,
			source: 'mcp-proxy-bearer',
		});
	};
}

export function createPortalApprovalVerifier(props: {
	readonly approvalTokenReplayCacheLimit?: number;
	readonly auditErrorSink?: (error: Error, event: PortalApprovalAuditEvent) => void;
	readonly auditSink?: (event: PortalApprovalAuditEvent) => void;
	readonly records: ReadonlyMap<string, PortalAgentRuntimeRecord>;
}): (
	calls: readonly PortalApprovalCall[],
	agentId: string,
	token: string | undefined,
) => PortalApprovalEvaluation {
	function auditApproval(event: Omit<PortalApprovalAuditEvent, 'kind' | 'timeMs'>): void {
		const auditEvent = { ...event, kind: 'mcp_portal_approval', timeMs: Date.now() } as const;
		try {
			props.auditSink?.(auditEvent);
		} catch (error) {
			props.auditErrorSink?.(error instanceof Error ? error : new Error(String(error)), auditEvent);
		}
	}

	const consumedApprovalTokenIds = new Map<string, number>();
	const replayCacheLimit = props.approvalTokenReplayCacheLimit ?? approvalTokenReplayCacheLimit;
	const consumeTokenId = (
		agentId: string,
		jti: string,
		expiresAtMs: number,
	):
		| { readonly ok: true }
		| { readonly ok: false; readonly reason: 'replay-cache-full' | 'replayed' } => {
		const nowMs = Date.now();
		for (const [tokenKey, tokenExpiresAtMs] of consumedApprovalTokenIds) {
			if (tokenExpiresAtMs <= nowMs) {
				consumedApprovalTokenIds.delete(tokenKey);
			}
		}
		const tokenKey = `${agentId}\n${jti}`;
		if (consumedApprovalTokenIds.has(tokenKey)) {
			return { ok: false, reason: 'replayed' };
		}
		if (consumedApprovalTokenIds.size >= replayCacheLimit) {
			return { ok: false, reason: 'replay-cache-full' };
		}
		consumedApprovalTokenIds.set(tokenKey, expiresAtMs);
		return { ok: true };
	};
	const evaluateApproval = createPortalPolicyApprovalEvaluator({
		consumeTokenId,
		maxLifetimeMs: approvalTokenMaxLifetimeMs,
		resolveRecord: (agentId) => props.records.get(agentId),
	});

	function auditEvaluation(agentId: string, evaluation: PortalApprovalEvaluation): void {
		const decisions = Object.values(evaluation.decisionsByCallId);
		const firstDeny = decisions.find((decision) => decision.kind !== 'allow');
		if (firstDeny === undefined) {
			auditApproval({
				agentId,
				decision: 'allow',
				...(decisions.length === 0 ? { reason: 'no_approval_required' } : {}),
			});
			return;
		}
		auditApproval({
			agentId,
			decision: 'deny',
			reason: auditReasonFromDecision(firstDeny),
			...(firstDeny.kind === 'approval_token_invalid' ? { verifierReason: firstDeny.reason } : {}),
		});
	}

	return (calls, agentId, token) => {
		const evaluation = evaluateApproval(calls, agentId, token);
		auditEvaluation(agentId, evaluation);
		return evaluation;
	};
}

function auditReasonFromDecision(
	decision: PortalApprovalCallDecision,
): Exclude<PortalApprovalAuditEvent['reason'], undefined> {
	switch (decision.kind) {
		case 'allow':
			return 'no_approval_required';
		case 'approval_token_invalid':
			return 'approval_token_invalid';
		case 'approval_token_missing':
			return 'approval_token_missing';
		case 'call_blocked':
			return 'call_blocked';
		case 'approval_required':
		case 'approval_configuration_missing':
			return 'per_call_evaluation';
		default: {
			const exhaustiveDecision: never = decision;
			throw new Error(
				`Unhandled MCP Portal approval audit decision: ${JSON.stringify(exhaustiveDecision)}`,
			);
		}
	}
}
