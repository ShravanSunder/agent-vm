import type { SecretResolver } from '@shravansunder/gondolin-core';
import { resolveServiceAccountToken } from '@shravansunder/gondolin-core';

import type { SystemConfig } from '../config/system-config.js';
import { createCompositeSecretResolver } from './composite-secret-resolver.js';

export async function createSecretResolverFromSystemConfig(
	systemConfig: SystemConfig,
	createSecretResolverImpl: (options: {
		readonly serviceAccountToken: string;
	}) => Promise<SecretResolver>,
	resolveTokenImpl: typeof resolveServiceAccountToken = resolveServiceAccountToken,
): Promise<SecretResolver> {
	let onePasswordResolver: SecretResolver | null = null;
	if (systemConfig.host.secretsProvider) {
		const serviceAccountToken = await resolveTokenImpl(
			systemConfig.host.secretsProvider.tokenSource,
		);
		onePasswordResolver = await createSecretResolverImpl({
			serviceAccountToken,
		});
	}

	return createCompositeSecretResolver(onePasswordResolver);
}

export const createSecretResolver = createSecretResolverFromSystemConfig;

export async function resolveControllerGithubToken(
	systemConfig: SystemConfig,
	secretResolver: SecretResolver,
): Promise<string | null> {
	const githubTokenConfig = systemConfig.host.githubToken;
	if (!githubTokenConfig) {
		return process.env.GITHUB_TOKEN ?? null;
	}

	return await secretResolver.resolve(
		githubTokenConfig.source === 'environment'
			? {
					source: 'environment',
					ref: githubTokenConfig.envVar,
				}
			: {
					source: '1password',
					ref: githubTokenConfig.ref,
				},
	);
}

export function findConfiguredZone(
	systemConfig: SystemConfig,
	zoneId: string,
): SystemConfig['zones'][number] {
	const zone = systemConfig.zones.find((candidateZone) => candidateZone.id === zoneId);
	if (!zone) {
		throw new Error(`Unknown zone '${zoneId}'.`);
	}
	return zone;
}
