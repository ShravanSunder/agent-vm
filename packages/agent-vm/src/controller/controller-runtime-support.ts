import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
	createCompositeSecretResolver,
	resolveServiceAccountToken,
	type SecretResolver,
} from '@agent-vm/secret-management';

import { findPackageJsonPathFromStart } from '../build/runtime-versions.js';
import type { SystemConfig } from '../config/system-config.js';

async function readPackageVersionFromStart(startPath: string): Promise<string> {
	const packageJsonPath = await findPackageJsonPathFromStart(startPath);
	const packageJson: unknown = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
	if (
		typeof packageJson !== 'object' ||
		packageJson === null ||
		!('version' in packageJson) ||
		typeof packageJson.version !== 'string' ||
		packageJson.version.length === 0
	) {
		throw new Error(`Missing package version in ${packageJsonPath}.`);
	}
	return packageJson.version;
}

export async function readAgentVmPackageVersion(
	startPath: string = fileURLToPath(import.meta.url),
): Promise<string> {
	return await readPackageVersionFromStart(startPath);
}

export async function createSecretResolverFromSystemConfig(
	systemConfig: SystemConfig,
	createSecretResolverImpl: (options: {
		readonly integrationVersion: string;
		readonly serviceAccountToken: string;
	}) => Promise<SecretResolver>,
	resolveTokenImpl: typeof resolveServiceAccountToken = resolveServiceAccountToken,
	readAgentVmPackageVersionImpl: () => Promise<string> = readAgentVmPackageVersion,
): Promise<SecretResolver> {
	let onePasswordResolver: SecretResolver | null = null;
	if (systemConfig.host.secretsProvider) {
		const integrationVersion = await readAgentVmPackageVersionImpl();
		const serviceAccountToken = await resolveTokenImpl(
			systemConfig.host.secretsProvider.tokenSource,
		);
		onePasswordResolver = await createSecretResolverImpl({
			integrationVersion,
			serviceAccountToken,
		});
	}

	return createCompositeSecretResolver(onePasswordResolver);
}

export const createSecretResolver = createSecretResolverFromSystemConfig;

export async function resolveControllerGithubToken(
	systemConfig: SystemConfig,
	secretResolver: SecretResolver,
	writeWarning: (message: string) => void = (message) => process.stderr.write(message),
): Promise<string | null> {
	const githubTokenConfig = systemConfig.host.githubToken;
	if (!githubTokenConfig) {
		const ambientGithubToken = process.env.GITHUB_TOKEN ?? null;
		if (ambientGithubToken !== null) {
			writeWarning(
				'[agent-vm] host.githubToken is not configured; using ambient GITHUB_TOKEN from the controller environment.\n',
			);
		}
		return ambientGithubToken;
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
