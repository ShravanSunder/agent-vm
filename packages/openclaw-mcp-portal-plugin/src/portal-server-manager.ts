import { createHash, randomBytes } from 'node:crypto';

import { portalMcpToolNames, type PortalBindingIdentity } from '@agent-vm/mcp-portal';

import type { PortalAgentRecord } from './portal-agent-registry.js';

export interface PortalBindingRecord extends PortalBindingIdentity {
	readonly route: string;
	readonly secret: string;
	readonly serverName: string;
}

export interface PortalBindingsForAgentsInput {
	readonly agents: readonly PortalAgentRecord[];
	readonly baseUrl: string;
	readonly secretFactory?: (agentId: string, bindingId: string) => string;
}

export interface PortalBindingsForAgentsResult {
	readonly agentToolAllowlists: Readonly<Record<string, readonly string[]>>;
	readonly bindings: readonly PortalBindingRecord[];
	readonly mcpServers: Readonly<Record<string, unknown>>;
}

function sanitizeIdentifier(value: string, separator: '-' | '_'): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, separator)
		.replace(new RegExp(`${separator}+`, 'g'), separator)
		.replace(new RegExp(`^${separator}|${separator}$`, 'g'), '');

	return sanitized.length === 0 ? 'agent' : sanitized;
}

function shortHash(value: string): string {
	return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function createPortalServerName(agentId: string): string {
	return `mcp_portal_${sanitizeIdentifier(agentId, '_')}_${shortHash(agentId)}`;
}

export function createPortalBindingId(agentId: string): string {
	return `mcp-portal-${sanitizeIdentifier(agentId, '-')}-${shortHash(agentId)}`;
}

export function createPortalBindingSecret(): string {
	return randomBytes(32).toString('base64url');
}

export function materializedPortalToolNames(serverName: string): readonly string[] {
	return portalMcpToolNames.map((toolName) => `${serverName}__${toolName}`);
}

export function createPortalBindingsForAgents(
	input: PortalBindingsForAgentsInput,
): PortalBindingsForAgentsResult {
	const bindings: PortalBindingRecord[] = [];
	const mcpServers: Record<string, unknown> = {};
	const agentToolAllowlists: Record<string, readonly string[]> = {};

	for (const agent of input.agents) {
		const serverName = createPortalServerName(agent.id);
		const bindingId = createPortalBindingId(agent.id);
		const route = `/mcp-portal/bindings/${bindingId}/mcp`;
		const secret = (input.secretFactory ?? (() => createPortalBindingSecret()))(
			agent.id,
			bindingId,
		);
		bindings.push({ agentId: agent.id, bindingId, route, secret, serverName });
		mcpServers[serverName] = {
			headers: { 'x-mcp-portal-binding-secret': secret },
			transport: 'streamable-http',
			url: `${input.baseUrl}${route}`,
		};
		agentToolAllowlists[agent.id] = materializedPortalToolNames(serverName);
	}

	return {
		agentToolAllowlists,
		bindings,
		mcpServers,
	};
}
