import { lstat, readFile, mkdir, writeFile, rename, unlink, realpath } from 'node:fs/promises';
import { dirname, resolve, parse, basename, join } from 'node:path';

import { z } from 'zod';

export const authTargetSchema = z.strictObject({
	issuer: z.url(),
	managementAudience: z.string().min(1),
	gatewayUrl: z.url(),
	ownerCliClientId: z.string().min(1),
	ownerCliRedirectUri: z.url(),
	organizationId: z.uuid(),
	workspaceId: z.uuid(),
	tokenCachePath: z.string().min(1),
});
export type AuthTarget = z.infer<typeof authTargetSchema>;
export const cachedOwnerTokenSchema = z.strictObject({
	issuer: z.url(),
	audience: z.string(),
	clientId: z.string(),
	token: z.string().min(1),
	expiresAt: z.number().int(),
});
export type CachedOwnerToken = z.infer<typeof cachedOwnerTokenSchema>;

async function canonicalRuntimePath(file: string): Promise<string> {
	try {
		return await realpath(file);
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
		return join(await canonicalRuntimePath(dirname(file)), basename(file));
	}
}

/** Verification inputs and credentials must never become files in a checkout. */
export async function requirePrivateRuntimePath(file: string, exists: boolean): Promise<string> {
	const requested = resolve(file);
	if (exists) {
		const information = await lstat(requested);
		if (
			!information.isFile() ||
			(information.mode & 0o077) !== 0 ||
			(process.getuid !== undefined && information.uid !== process.getuid())
		)
			throw new Error('Auth runtime file must be an owned private regular file');
	}
	const absolute = await canonicalRuntimePath(requested);
	let ancestor = dirname(absolute);
	const ancestors: string[] = [];
	while (true) {
		ancestors.push(ancestor);
		if (ancestor === parse(ancestor).root) break;
		ancestor = dirname(ancestor);
	}
	const inCheckouts = await Promise.all(
		ancestors.map(async (directory) =>
			lstat(`${directory}/.git`).then(
				() => true,
				(error: unknown) => {
					if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
					throw error;
				},
			),
		),
	);
	if (inCheckouts.some(Boolean))
		throw new Error('Auth runtime files must be outside Git checkouts');
	return absolute;
}

export async function readAuthTarget(file: string): Promise<AuthTarget> {
	const target = authTargetSchema.parse(
		JSON.parse(await readFile(await requirePrivateRuntimePath(file, true), 'utf8')),
	);
	const redirect = new URL(target.ownerCliRedirectUri);
	if (
		redirect.protocol !== 'http:' ||
		!['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname) ||
		redirect.username !== '' ||
		redirect.password !== '' ||
		redirect.hash !== ''
	)
		throw new Error('Owner CLI needs its registered HTTP loopback redirect');
	await requirePrivateRuntimePath(target.tokenCachePath, false);
	return target;
}

export async function saveOwnerToken(file: string, token: CachedOwnerToken): Promise<void> {
	const destination = await requirePrivateRuntimePath(file, false);
	await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
	const temporary = `${destination}.${crypto.randomUUID()}`;
	try {
		await writeFile(temporary, JSON.stringify(token), { mode: 0o600, flag: 'wx' });
		await rename(temporary, destination);
	} finally {
		await unlink(temporary).catch((error: unknown) => {
			if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
		});
	}
}
