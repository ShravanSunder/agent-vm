import { z } from 'zod';

import {
	agentAdmissionSchema,
	type AgentAdmission,
} from '#tool-host-core/organization-authority/models/organization-authority-state';

export function isStoredAgentListed(stored: unknown): boolean {
	return stored === undefined ? false : agentAdmissionSchema.parse(stored).state === 'listed';
}

export function agentAdmissionRow(props: {
	readonly agentClientId: string;
	readonly state: AgentAdmission['state'];
}): { readonly key: string; readonly value: AgentAdmission } {
	z.string().min(1).parse(props.agentClientId);
	return {
		key: `agent:${props.agentClientId}`,
		value: agentAdmissionSchema.parse({ state: props.state }),
	};
}
