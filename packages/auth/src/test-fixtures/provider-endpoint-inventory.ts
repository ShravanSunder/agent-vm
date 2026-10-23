import type { Miniflare } from 'miniflare';
import { z } from 'zod';

import { createSignInProvider } from '#auth/better-auth-provider/provider-configuration';
import { signInWorkerConfiguration } from '#auth/cloudflare-host/worker-configuration';

const endpointSchema = z.object({
	path: z.string().startsWith('/').optional(),
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
export interface ProviderApiWithoutHttpPath {
	readonly endpointName: string;
	readonly serverOnly: boolean;
}
export interface ProviderEndpointInventory {
	readonly httpRoutes: readonly ProviderHttpRoute[];
	readonly noHttpPathApis: readonly ProviderApiWithoutHttpPath[];
}

/** Includes every installed API; pathless server APIs stay explicit beside the HTTP method matrix. */
export async function installedProviderEndpointInventory(
	runtime: Miniflare,
): Promise<ProviderEndpointInventory> {
	const bindings = await runtime.getBindings<AuthWorkerEnv>('sign-in');
	const provider = createSignInProvider({
		...signInWorkerConfiguration(bindings),
		authority: { kind: 'public' },
		requestState: { createdUserIds: [], issuedSessions: [] },
	});
	await provider.$context;
	const noHttpPathApis: ProviderApiWithoutHttpPath[] = [];
	const httpRoutes = Object.entries(provider.api).flatMap(([endpointName, endpoint]) => {
		const descriptor = endpointSchema.parse({ path: endpoint.path, options: endpoint.options });
		if (descriptor.path === undefined) {
			noHttpPathApis.push({
				endpointName,
				serverOnly: descriptor.options.metadata?.SERVER_ONLY === true,
			});
			return [];
		}
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
	return {
		httpRoutes,
		noHttpPathApis: noHttpPathApis.toSorted((left, right) =>
			left.endpointName.localeCompare(right.endpointName),
		),
	};
}
