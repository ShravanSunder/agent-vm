import {
	createSecretResolver,
	resolveServiceAccountToken,
	type SecretResolver,
} from 'gondolin-core';

import type { SystemConfig } from './system-config.js';

export async function createSecretResolverFromSystemConfig(
	systemConfig: SystemConfig,
	createSecretResolverImpl: typeof createSecretResolver,
	resolveTokenImpl: typeof resolveServiceAccountToken = resolveServiceAccountToken,
): Promise<SecretResolver> {
	const serviceAccountToken = await resolveTokenImpl(
		systemConfig.host.secretsProvider.tokenSource,
	);

	return await createSecretResolverImpl({
		serviceAccountToken,
	});
}

export function findConfiguredZone(
	systemConfig: SystemConfig,
	zoneId: string,
): SystemConfig['zones'][number] {
	const zone = systemConfig.zones.find(
		(candidateZone) => candidateZone.id === zoneId,
	);
	if (!zone) {
		throw new Error(`Unknown zone '${zoneId}'.`);
	}
	return zone;
}
