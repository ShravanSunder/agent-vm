import { z } from 'zod';

import {
	agentAdmissionSchema,
	type AgentAdmission,
} from '#tool-host-core/workspace-authority/models/workspace-authority-state';

export function storedWorkspaceMembership(stored: unknown): { readonly persona: string } | null {
	if (stored === undefined) return null;
	const row = agentAdmissionSchema.parse(stored);
	return row.state === 'member' ? { persona: row.persona } : null;
}

export function workspaceMembershipRow(props: {
	readonly agentClientId: string;
	readonly persona: string;
	readonly state: AgentAdmission['state'];
}): { readonly key: string; readonly value: AgentAdmission } {
	z.string().min(1).parse(props.agentClientId);
	return {
		key: `member:${props.agentClientId}`,
		value: agentAdmissionSchema.parse({ state: props.state, persona: props.persona }),
	};
}
