import {
	workspaceConfigurationSchema,
	type WorkspaceConfigurationSource,
	type SecretSource,
} from '@agent-collaboration/tool-host-core';
import { z } from 'zod';

/** S6 source: configuration deployed with the Worker. Versioned database configuration is deferred. */
export function deployedConfigurationSource(configurations: unknown): WorkspaceConfigurationSource {
	const parsed = z.record(z.uuid(), workspaceConfigurationSchema).parse(configurations);
	return {
		workspaceIdsForOrganization: async (organizationId) =>
			Object.entries(parsed)
				.filter(([, configuration]) => configuration.organizationId === organizationId)
				.map(([workspaceId]) => workspaceId),
		read: async (workspaceId) => {
			const configuration = parsed[workspaceId];
			if (configuration === undefined) throw new Error('Workspace configuration unavailable.');
			return configuration;
		},
	};
}

export function workerSecretBindings(bindings: Readonly<Record<string, unknown>>): SecretSource {
	return { read: (name) => z.string().min(1).parse(bindings[name]) };
}
