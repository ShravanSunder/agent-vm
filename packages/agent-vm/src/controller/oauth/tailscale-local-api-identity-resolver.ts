import { request } from 'node:http';
import { isIP } from 'node:net';

import { z } from 'zod';

import type { TailnetIdentityResolver, TailnetPeerIdentity } from './oauth-https-server.js';

const maximumWhoIsResponseBytes = 64 * 1_024;
const defaultRequestTimeoutMs = 5_000;

const tailscaleWhoIsResponseSchema = z
	.object({
		UserProfile: z
			.object({
				LoginName: z.string().min(1).max(320),
			})
			.passthrough(),
	})
	.passthrough();

const tailscaleStatusResponseSchema = z
	.object({
		Self: z
			.object({
				TailscaleIPs: z.array(z.string()).min(1).readonly(),
			})
			.passthrough(),
	})
	.passthrough();

export interface TailscaleLocalApiTransport {
	getJson(path: string): Promise<unknown>;
}

function formatSocketAddress(remoteAddress: string, remotePort: number): string {
	if (isIP(remoteAddress) === 0)
		throw new Error('Tailscale WhoIs requires a numeric peer address.');
	if (!Number.isSafeInteger(remotePort) || remotePort < 1 || remotePort > 65_535) {
		throw new Error('Tailscale WhoIs requires a valid peer port.');
	}
	return isIP(remoteAddress) === 6
		? `[${remoteAddress}]:${remotePort}`
		: `${remoteAddress}:${remotePort}`;
}

export function defaultTailscaleLocalApiSocketPath(
	platform: NodeJS.Platform = process.platform,
): string {
	if (platform === 'darwin') return '/var/run/tailscaled.socket';
	if (platform === 'linux') return '/var/run/tailscale/tailscaled.sock';
	throw new Error(`Tailscale LocalAPI is unsupported on platform "${platform}".`);
}

export function createTailscaleUnixSocketTransport(
	props: {
		readonly requestTimeoutMs?: number | undefined;
		readonly socketPath?: string | undefined;
	} = {},
): TailscaleLocalApiTransport {
	const socketPath = props.socketPath ?? defaultTailscaleLocalApiSocketPath();
	const requestTimeoutMs = props.requestTimeoutMs ?? defaultRequestTimeoutMs;
	if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
		throw new Error('Tailscale LocalAPI request timeout must be a positive safe integer.');
	}
	return {
		getJson: async (path): Promise<unknown> =>
			await new Promise<unknown>((resolve, reject) => {
				const localApiRequest = request(
					{
						headers: { host: 'local-tailscaled.sock' },
						method: 'GET',
						path,
						socketPath,
					},
					(response) => {
						const chunks: Buffer[] = [];
						let responseByteLength = 0;
						response.on('data', (chunk: Buffer) => {
							responseByteLength += chunk.byteLength;
							if (responseByteLength > maximumWhoIsResponseBytes) {
								localApiRequest.destroy(
									new Error('Tailscale LocalAPI WhoIs response exceeded its size limit.'),
								);
								return;
							}
							chunks.push(chunk);
						});
						response.on('end', () => {
							if (response.statusCode !== 200) {
								reject(
									new Error(
										`Tailscale LocalAPI WhoIs returned HTTP ${response.statusCode ?? 'unknown'}.`,
									),
								);
								return;
							}
							try {
								const parsedResponse: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
								resolve(parsedResponse);
							} catch (error) {
								reject(
									new Error('Tailscale LocalAPI WhoIs returned invalid JSON.', { cause: error }),
								);
							}
						});
					},
				);
				localApiRequest.setTimeout(requestTimeoutMs, () => {
					localApiRequest.destroy(new Error('Tailscale LocalAPI WhoIs request timed out.'));
				});
				localApiRequest.on('error', reject);
				localApiRequest.end();
			}),
	};
}

export function createTailscaleLocalApiIdentityResolver(
	props: {
		readonly transport?: TailscaleLocalApiTransport | undefined;
	} = {},
): TailnetIdentityResolver {
	const transport = props.transport ?? createTailscaleUnixSocketTransport();
	return {
		resolvePeerIdentity: async ({ remoteAddress, remotePort }): Promise<TailnetPeerIdentity> => {
			const address = formatSocketAddress(remoteAddress, remotePort);
			const response = tailscaleWhoIsResponseSchema.parse(
				await transport.getJson(`/localapi/v0/whois?addr=${encodeURIComponent(address)}`),
			);
			return { loginName: response.UserProfile.LoginName };
		},
	};
}

export async function resolveLocalTailscaleAddress(
	props: {
		readonly transport?: TailscaleLocalApiTransport | undefined;
	} = {},
): Promise<string> {
	const transport = props.transport ?? createTailscaleUnixSocketTransport();
	const status = tailscaleStatusResponseSchema.parse(
		await transport.getJson('/localapi/v0/status'),
	);
	const selectedAddress = status.Self.TailscaleIPs.find((address) => isIP(address) === 4);
	if (selectedAddress === undefined) {
		throw new Error('Tailscale LocalAPI status did not include a local IPv4 address.');
	}
	return selectedAddress;
}
