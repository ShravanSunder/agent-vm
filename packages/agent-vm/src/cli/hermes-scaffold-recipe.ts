import {
	renderHermesManagedImageRecipe,
	type HermesManagedImageRecipe,
} from '@agent-vm/hermes-gateway';

import type { ImageArchitecture, SecretsProvider } from './init-command-schemas.js';

const defaultHermesScaffoldAgentId = 'main';

export type HermesScaffoldSecretReference =
	| {
			readonly audience: 'gateway';
			readonly injection: 'env';
			readonly ref: string;
			readonly source: '1password';
	  }
	| {
			readonly audience: 'gateway';
			readonly envVar: string;
			readonly injection: 'env';
			readonly source: 'environment';
	  };

function environmentSuffixForAgentId(agentId: string): string {
	return agentId.toUpperCase().replaceAll(/[^A-Z0-9]/gu, '_');
}

function hermesSecretReference(options: {
	readonly audience: 'gateway';
	readonly envVar: string;
	readonly injection: 'env';
	readonly opRef: string;
	readonly secretsProvider: SecretsProvider;
}): HermesScaffoldSecretReference {
	return options.secretsProvider === '1password'
		? {
				audience: options.audience,
				injection: options.injection,
				ref: options.opRef,
				source: '1password',
			}
		: {
				audience: options.audience,
				envVar: options.envVar,
				injection: options.injection,
				source: 'environment',
			};
}

export function resolveHermesScaffoldAgentIds(
	agentIds: readonly string[] | undefined,
): readonly string[] {
	return agentIds && agentIds.length > 0 ? agentIds : [defaultHermesScaffoldAgentId];
}

export function createHermesProfileAssignments(
	agentIds: readonly string[] | undefined,
): Readonly<Record<string, string>> {
	return Object.fromEntries(
		resolveHermesScaffoldAgentIds(agentIds).map((agentId) => [agentId, agentId]),
	);
}

export function createHermesProfileSecretProjections(
	agentIds: readonly string[] | undefined,
): Readonly<Record<string, Readonly<Record<string, string>>>> {
	return Object.fromEntries(
		resolveHermesScaffoldAgentIds(agentIds).map((agentId) => {
			const environmentSuffix = environmentSuffixForAgentId(agentId);
			return [
				agentId,
				{
					API_SERVER_KEY: `HERMES_API_SERVER_KEY_${environmentSuffix}`,
					DISCORD_BOT_TOKEN: `DISCORD_BOT_TOKEN_${environmentSuffix}`,
				},
			];
		}),
	);
}

export function createHermesScaffoldSecrets(options: {
	readonly agentIds: readonly string[] | undefined;
	readonly secretsProvider: SecretsProvider;
	readonly zoneId: string;
}): Readonly<Record<string, HermesScaffoldSecretReference>> {
	const profileSecrets = Object.fromEntries(
		resolveHermesScaffoldAgentIds(options.agentIds).flatMap((agentId) => {
			const environmentSuffix = environmentSuffixForAgentId(agentId);
			return [
				[
					`HERMES_API_SERVER_KEY_${environmentSuffix}`,
					hermesSecretReference({
						audience: 'gateway',
						envVar: `HERMES_API_SERVER_KEY_${environmentSuffix}`,
						injection: 'env',
						opRef: `op://agent-vm/${options.zoneId}-${agentId}-hermes-api/credential`,
						secretsProvider: options.secretsProvider,
					}),
				],
				[
					`DISCORD_BOT_TOKEN_${environmentSuffix}`,
					hermesSecretReference({
						audience: 'gateway',
						envVar: `DISCORD_BOT_TOKEN_${environmentSuffix}`,
						injection: 'env',
						opRef: `op://agent-vm/${options.zoneId}-${agentId}-discord/credential`,
						secretsProvider: options.secretsProvider,
					}),
				],
			] as const;
		}),
	);
	return {
		API_SERVER_KEY: hermesSecretReference({
			audience: 'gateway',
			envVar: 'API_SERVER_KEY',
			injection: 'env',
			opRef: `op://agent-vm/${options.zoneId}-hermes-root-api/credential`,
			secretsProvider: options.secretsProvider,
		}),
		...profileSecrets,
	};
}

export function renderHermesManagedConfiguration(): string {
	return 'plugins:\n  enabled:\n    - agent-vm-tool-portal\n  disabled: []\n';
}

export function createHermesScaffoldImageRecipe(options: {
	readonly agentVmVersion: string;
	readonly architecture: ImageArchitecture;
}): HermesManagedImageRecipe {
	return renderHermesManagedImageRecipe({
		artifactContext: {
			agentVmVersion: options.agentVmVersion,
			kind: 'public-registry-context',
		},
		buildTarget: {
			architecture: options.architecture,
			kind: 'gondolin-custom-dockerfile',
			ociImage: `agent-vm-hermes:${options.architecture}`,
			rootfsSizeMb: 4096,
		},
	});
}
