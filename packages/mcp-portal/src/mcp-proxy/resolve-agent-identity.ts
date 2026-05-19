import {
	resolveMcpPortalProfile,
	mcpPortalCallRequiresApproval,
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

function approvalRequiredByProfile(
	profile: ResolvedMcpPortalProfile,
	call: PortalApprovalCall,
): boolean {
	const annotations = call.tool.annotations;
	return mcpPortalCallRequiresApproval(profile, {
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
	readonly records: ReadonlyMap<string, PortalAgentRuntimeRecord>;
}): (
	calls: readonly PortalApprovalCall[],
	agentId: string,
	token: string | undefined,
) =>
	| { readonly kind: 'allow' }
	| { readonly kind: 'approval_token_invalid'; readonly reason: string }
	| { readonly kind: 'approval_token_missing' } {
	const consumedApprovalTokenIds = new Map<string, number>();
	const consumeTokenId = (agentId: string, jti: string, expiresAtMs: number): boolean => {
		const nowMs = Date.now();
		for (const [tokenKey, tokenExpiresAtMs] of consumedApprovalTokenIds) {
			if (
				tokenExpiresAtMs <= nowMs ||
				consumedApprovalTokenIds.size > approvalTokenReplayCacheLimit
			) {
				consumedApprovalTokenIds.delete(tokenKey);
			}
		}
		const tokenKey = `${agentId}\n${jti}`;
		if (consumedApprovalTokenIds.has(tokenKey)) {
			return false;
		}
		consumedApprovalTokenIds.set(tokenKey, expiresAtMs);
		return true;
	};
	return (calls, agentId, token) => {
		const record = props.records.get(agentId);
		if (record === undefined) {
			return { kind: 'approval_token_invalid', reason: 'unknown-agent' };
		}
		const callsRequiringApproval = calls.filter((call) =>
			approvalRequiredByProfile(record.profile, call),
		);
		if (callsRequiringApproval.length === 0) {
			return { kind: 'allow' };
		}
		if (token === undefined) {
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
			return { kind: 'allow' };
		}
		return { kind: 'approval_token_invalid', reason: verification.reason };
	};
}
