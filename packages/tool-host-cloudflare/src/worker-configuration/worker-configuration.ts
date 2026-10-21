import { z } from 'zod';

import {
	organizationConfigurationSchema,
	type OrganizationConfigurationSource,
	type WorkerSecretBindings,
} from '#worker-host/worker-configuration/models/worker-configuration';

/** S6 source: configuration deployed with the Worker. Versioned database configuration is deferred. */
export function deployedConfigurationSource(
	configurations: unknown,
): OrganizationConfigurationSource {
	const parsed = z.record(z.uuid(), organizationConfigurationSchema).parse(configurations);
	return {
		read: async (organizationId) => {
			const configuration = parsed[organizationId];
			if (configuration === undefined) throw new Error('Organization configuration unavailable.');
			return configuration;
		},
	};
}

export function workerSecretBindings(
	bindings: Readonly<Record<string, unknown>>,
): WorkerSecretBindings {
	return { read: (name) => z.string().min(1).parse(bindings[name]) };
}
