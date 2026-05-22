import {
	createCompositeSecretResolver,
	resolveServiceAccountToken,
	type SecretResolver,
} from '@agent-vm/secrets';

import type { SystemConfig } from '../config/system-config.js';

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

	switch (githubTokenConfig.source) {
		case 'environment':
			return await secretResolver.resolve({
				source: 'environment',
				ref: githubTokenConfig.envVar,
			});
		case '1password':
			return await secretResolver.resolve({
				source: '1password',
				ref: githubTokenConfig.ref,
			});
		case 'config':
			return await secretResolver.resolve({
				source: 'config',
				value: githubTokenConfig.value,
			});
		default: {
			const exhaustiveCheck: never = githubTokenConfig;
			throw new Error(`Unsupported GitHub token source: ${JSON.stringify(exhaustiveCheck)}`);
		}
	}
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
