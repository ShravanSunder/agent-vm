import {
	createPortalAgentIdentity,
	type PortalAgentIdentity,
} from '#tool-access/authorization/portal-access-policy';
import type { Principal } from '#tool-access/contracts/workspace-token-claims';

/** Identity excludes changing launch facts and credential IDs; the whole session reference distinguishes sessions. */
export function workspacePrincipalKey(principal: Principal): string {
	switch (principal.kind) {
		case 'bot':
			return JSON.stringify(['bot', principal.bot_id]);
		case 'fleetHarnessSession':
			return JSON.stringify([
				'fleetHarnessSession',
				principal.session_ref.installation,
				principal.session_ref.harness_endpoint,
				principal.session_ref.conversation_id,
			]);
	}
}

export function createWorkspacePrincipalIdentity(principal: Principal): PortalAgentIdentity {
	const principalKey = workspacePrincipalKey(principal);
	return createPortalAgentIdentity({
		agentId: principalKey,
		agentScopeId: principalKey,
		source: 'mcp-proxy-bearer',
	});
}
