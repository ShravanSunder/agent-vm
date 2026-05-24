import {
	resolveMcpPortalProfile,
	mcpPortalCallPolicyDecision,
	type McpPortalAgentConfig,
	type McpPortalConfig,
	type ResolvedMcpPortalProfile,
	type SecretValue,
} from '@agent-vm/config-contracts';

import type { PortalApprovalCall } from '../core/portal-tools.js';
import { createPortalAgentIdentity } from '../portal-access-policy.js';
import { hashCallArguments, verifyApprovalToken } from '../portal-auth/hmac-token.js';

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
		| 'no_approval_required';
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

function callDecisionByProfile(
	profile: ResolvedMcpPortalProfile,
	call: PortalApprovalCall,
): ReturnType<typeof mcpPortalCallPolicyDecision> {
	const annotations = call.tool.annotations;
	return mcpPortalCallPolicyDecision(profile, {
		...(annotations === undefined ? {} : { annotations }),
		namespace: call.namespace,
		toolName: call.toolName,
	});
}

function approvalTokenCallDigests(calls: readonly PortalApprovalCall[]): readonly {
	readonly argumentsHash: string;
	readonly namespace: string;
	readonly toolName: string;
}[] {
	return calls.map((call) => ({
		argumentsHash: hashCallArguments(call.arguments),
		namespace: call.namespace,
		toolName: call.toolName,
	}));
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
) =>
	| { readonly kind: 'allow' }
	| { readonly kind: 'call_blocked' }
	| { readonly kind: 'approval_token_invalid'; readonly reason: string }
	| { readonly kind: 'approval_token_missing' } {
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
	return (calls, agentId, token) => {
		const record = props.records.get(agentId);
		if (record === undefined) {
			auditApproval({
				agentId,
				decision: 'deny',
				reason: 'approval_token_invalid',
				verifierReason: 'unknown-agent',
			});
			return { kind: 'approval_token_invalid', reason: 'unknown-agent' };
		}
		const callDecisions = calls.map((call) => callDecisionByProfile(record.profile, call));
		if (callDecisions.some((decision) => decision.kind === 'blocked')) {
			auditApproval({ agentId, decision: 'deny', reason: 'call_blocked' });
			return { kind: 'call_blocked' };
		}
		const callsRequiringApproval = calls.filter(
			(_call, index) => callDecisions[index]?.kind === 'requires_approval',
		);
		if (callsRequiringApproval.length === 0) {
			auditApproval({ agentId, decision: 'allow', reason: 'no_approval_required' });
			return { kind: 'allow' };
		}
		if (token === undefined) {
			auditApproval({ agentId, decision: 'deny', reason: 'approval_token_missing' });
			return { kind: 'approval_token_missing' };
		}
		const verificationProps = {
			agentId,
			calls: approvalTokenCallDigests(callsRequiringApproval),
			consumeTokenId: (jti: string, expiresAtMs: number) =>
				consumeTokenId(agentId, jti, expiresAtMs),
			key: record.hmacKey,
			maxLifetimeMs: approvalTokenMaxLifetimeMs,
			nowMs: Date.now(),
			token,
		};
		const verification = verifyApprovalToken(verificationProps);
		if (verification.ok) {
			auditApproval({ agentId, decision: 'allow' });
			return { kind: 'allow' };
		}
		auditApproval({
			agentId,
			decision: 'deny',
			reason: 'approval_token_invalid',
			verifierReason: verification.reason,
		});
		return { kind: 'approval_token_invalid', reason: verification.reason };
	};
}
