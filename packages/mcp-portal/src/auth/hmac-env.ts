const portalHmacKeyEnvPrefix = 'PORTAL_HMAC_KEY__';
const portalHmacKeyHexLength = 64;

export function portalHmacKeyEnvName(agentId: string): string {
	return `${portalHmacKeyEnvPrefix}${agentId}`;
}

export function parseHmacKeysFromEnv(
	env: Readonly<Record<string, string | undefined>>,
): ReadonlyMap<string, Buffer> {
	const keysByAgent = new Map<string, Buffer>();
	for (const [name, value] of Object.entries(env)) {
		if (!name.startsWith(portalHmacKeyEnvPrefix) || value === undefined) {
			continue;
		}
		const agentId = name.slice(portalHmacKeyEnvPrefix.length);
		if (!/^[0-9a-f]+$/u.test(value) || value.length !== portalHmacKeyHexLength) {
			throw new Error(`Malformed HMAC key in env var "${name}".`);
		}
		keysByAgent.set(agentId, Buffer.from(value, 'hex'));
	}
	return keysByAgent;
}
