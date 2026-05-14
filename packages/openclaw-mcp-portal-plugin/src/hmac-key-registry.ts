import { randomBytes } from 'node:crypto';

import { portalHmacKeyEnvName } from '@agent-vm/mcp-portal';

const hmacKeyBytes = 32;

export interface CreateHmacKeyRegistryProps {
	readonly agentIds: readonly string[];
}

export interface HmacKeyRegistry {
	readonly agentIds: readonly string[];
	readonly getKey: (agentId: string) => Buffer;
	readonly serializeForEnv: () => Readonly<Record<string, string>>;
}

export function createHmacKeyRegistry(props: CreateHmacKeyRegistryProps): HmacKeyRegistry {
	const keysByAgent = new Map<string, Buffer>();
	for (const agentId of props.agentIds) {
		keysByAgent.set(agentId, randomBytes(hmacKeyBytes));
	}

	return {
		agentIds: [...props.agentIds],
		getKey: (agentId) => {
			const key = keysByAgent.get(agentId);
			if (key === undefined) {
				throw new Error(`HMAC key registry: unknown agent "${agentId}".`);
			}
			return key;
		},
		serializeForEnv: () =>
			Object.fromEntries(
				[...keysByAgent.entries()].map(([agentId, key]) => [
					portalHmacKeyEnvName(agentId),
					key.toString('hex'),
				]),
			),
	};
}
