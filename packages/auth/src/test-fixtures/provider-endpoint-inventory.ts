import type { Miniflare } from 'miniflare';
import { z } from 'zod';

import { createSignInProvider } from '#auth/better-auth-provider/provider-configuration';
import { signInWorkerConfiguration } from '#auth/cloudflare-host/worker-configuration';

const endpointSchema = z.object({
	path: z.string().startsWith('/'),
	options: z.object({
		method: z.union([z.string(), z.array(z.string())]),
		metadata: z.object({ SERVER_ONLY: z.boolean().optional() }).optional(),
	}),
});
export interface ProviderHttpRoute {
	readonly endpointName: string;
	readonly method: string;
	readonly path: string;
	readonly serverOnly: boolean;
}

/** Reads the configured provider's actual core/plugin endpoint table, including installed method arrays. */
export async function installedProviderHttpRoutes(
	runtime: Miniflare,
): Promise<readonly ProviderHttpRoute[]> {
	const bindings = await runtime.getBindings<AuthWorkerEnv>('sign-in');
	const provider = createSignInProvider({
		...signInWorkerConfiguration(bindings),
		authority: { kind: 'public' },
		requestState: { createdUserIds: [], issuedSessions: [] },
	});
	await provider.$context;
	return Object.entries(provider.api).flatMap(([endpointName, endpoint]) => {
		const descriptor = endpointSchema.parse({ path: endpoint.path, options: endpoint.options });
		const methods = Array.isArray(descriptor.options.method)
			? descriptor.options.method
			: [descriptor.options.method];
		return methods.flatMap((method) =>
			(method === '*'
				? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
				: [method]
			).map((httpMethod) => ({
				endpointName,
				method: httpMethod,
				path: `/api/auth${descriptor.path}`,
				serverOnly: descriptor.options.metadata?.SERVER_ONLY === true,
			})),
		);
	});
}
