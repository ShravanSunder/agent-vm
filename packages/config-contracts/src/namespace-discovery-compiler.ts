import { z } from 'zod';

import type { McpConfig } from './mcp-config.js';
import { namespaceDiscoverySchema } from './mcp-config.js';
import type { ToolPortalConfig } from './tool-portal-config.js';

export const toolPortalEffectiveNamespaceDiscoverySchema = namespaceDiscoverySchema
	.extend({ namespace: z.string().min(1) })
	.strict();

export type ToolPortalEffectiveNamespaceDiscovery = z.infer<
	typeof toolPortalEffectiveNamespaceDiscoverySchema
>;

export type ToolPortalNamespaceDiscoveryByProfile = Readonly<
	Record<string, readonly ToolPortalEffectiveNamespaceDiscovery[]>
>;

function compareUnicodeCodePointStrings(left: string, right: string): number {
	const leftCodePoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
	const rightCodePoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
	const sharedLength = Math.min(leftCodePoints.length, rightCodePoints.length);
	for (let index = 0; index < sharedLength; index += 1) {
		const difference = (leftCodePoints[index] ?? 0) - (rightCodePoints[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return leftCodePoints.length - rightCodePoints.length;
}

export function compileToolPortalNamespaceDiscoveryByProfile(props: {
	readonly mcpConfig: McpConfig;
	readonly toolPortalConfig: ToolPortalConfig;
}): ToolPortalNamespaceDiscoveryByProfile {
	const providersByNamespace = new Map<string, McpConfig['providers'][string][]>();
	for (const provider of Object.values(props.mcpConfig.providers)) {
		const providers = providersByNamespace.get(provider.namespace) ?? [];
		providers.push(provider);
		providersByNamespace.set(provider.namespace, providers);
	}

	const discoveryByProfile = Object.fromEntries(
		Object.entries(props.toolPortalConfig.profiles).map(([profileId, profile]) => {
			const namespaceDiscovery = Object.entries(profile.namespaces)
				.map(([namespace, namespacePolicy]): ToolPortalEffectiveNamespaceDiscovery => {
					if ('discovery' in namespacePolicy) {
						return toolPortalEffectiveNamespaceDiscoverySchema.parse({
							...namespacePolicy.discovery,
							namespace,
						});
					}
					const matchingProviders = providersByNamespace.get(namespace) ?? [];
					if (matchingProviders.length !== 1) {
						throw new Error(
							`Tool Portal profile "${profileId}" MCP namespace "${namespace}" must resolve to exactly one MCP provider; found ${matchingProviders.length}.`,
						);
					}
					return toolPortalEffectiveNamespaceDiscoverySchema.parse({
						...matchingProviders[0]?.discovery,
						namespace,
					});
				})
				.toSorted((left, right) => compareUnicodeCodePointStrings(left.namespace, right.namespace));
			return [profileId, Object.freeze(namespaceDiscovery)] as const;
		}),
	);
	return Object.freeze(discoveryByProfile);
}
