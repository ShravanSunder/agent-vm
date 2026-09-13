import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { arch } from 'node:process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import type { JsonValue, PortalCallRequest, PortalCallResult } from '@agent-vm/agent-portal-sdk';
import type { GatewayRuntimeToolPortalDispatchAuthorityForBackendKind } from '@agent-vm/gateway-control-contracts';
import type { ManagedVmRequestMediation } from '@agent-vm/managed-vm';
import {
	oauthAccountIdSchema,
	oauthAuthorizationIdSchema,
	oauthCredentialIdSchema,
} from '@agent-vm/oauth-broker-contracts';

const execFileAsync = promisify(execFile);

export const pinnedGogRuntimeIdentity = {
	accessToken: 'pinned-gog-runtime-access-token',
	accountId: oauthAccountIdSchema.parse('33333333-3333-4333-8333-333333333333'),
	authorityContext: {
		controllerEpoch: 'pinned-gog-controller',
		frameworkEpoch: 'pinned-gog-framework',
		gatewayEpoch: 'pinned-gog-gateway',
		runtimeEpoch: 'pinned-gog-runtime',
		zoneId: 'pinned-gog-runtime-zone',
	},
	authorizationId: oauthAuthorizationIdSchema.parse('44444444-4444-4444-8444-444444444444'),
	credentialId: oauthCredentialIdSchema.parse('55555555-5555-4555-8555-555555555555'),
	principal: {
		agentId: 'sun',
		frameworkIdentity: { kind: 'hermes', profileName: 'sun' },
		profileAssignmentRevision: 'pinned-gog-assignment',
		toolPortalProfileId: 'shared',
	},
} as const;
export const pinnedGogPublishedFileContents = 'synthetic-pdf-bytes';

function describePinnedGogSyntheticError(value: unknown, depth: number, seen: Set<Error>): string {
	if (!(value instanceof Error)) return String(value);
	if (seen.has(value)) return '[cyclic-error-cause]';
	seen.add(value);
	const cause =
		value.cause === undefined
			? ''
			: depth >= 3
				? '; cause: [depth-limit]'
				: `; cause: ${describePinnedGogSyntheticError(value.cause, depth + 1, seen)}`;
	return `${value.name}: ${value.message}${cause}`;
}

export function formatPinnedGogSyntheticDiagnostic(error: unknown, accessToken: string): string {
	const redacted = describePinnedGogSyntheticError(error, 0, new Set()).replaceAll(
		accessToken,
		'[redacted-synthetic-token]',
	);
	return redacted.length <= 2048 ? redacted : `${redacted.slice(0, 2048)}[truncated]`;
}

const gogRelease = {
	version: '0.38.1',
	assets: {
		arm64: {
			archive: 'gogcli_0.38.1_linux_arm64.tar.gz',
			sha256: '462342542472dcf361744cfe5e15a3540364b4c5120577e4519fffbd1afc6596',
		},
		x64: {
			archive: 'gogcli_0.38.1_linux_amd64.tar.gz',
			sha256: '6576828ed6852949ba424b967c3ff4268b3d9c90e201f90fe3d539fe3a151ebb',
		},
	},
} as const;

export interface PinnedGogRuntimeArtifact {
	readonly directoryPath: string;
	readonly executablePath: string;
	readonly version: typeof gogRelease.version;
}

export function createPinnedGogPortalCall(props: {
	readonly accountId: ReturnType<typeof oauthAccountIdSchema.parse>;
	readonly argv: readonly string[];
	readonly id: string;
}): PortalCallRequest {
	return {
		calls: [
			{
				id: props.id,
				namespace: 'google',
				name: 'gog',
				arguments: {
					accountId: props.accountId,
					argv: [...props.argv],
					reason: `Proof ${props.id}`,
				},
			},
		],
	};
}

export function pinnedGogControllerDispatchIdentity(
	authority: GatewayRuntimeToolPortalDispatchAuthorityForBackendKind<'controller_execution'>,
): { readonly fingerprint: string; readonly operationId: string } {
	if (authority.kind === 'without-approval') return authority;
	return authority.kind === 'controller-approval-reservation'
		? authority.reservation
		: authority.grant;
}

export function createPinnedGogPortalSuccess(props: {
	readonly call: PortalCallRequest['calls'][number];
	readonly operationId: string;
	readonly owningGeneration: string;
	readonly value: JsonValue;
}): PortalCallResult {
	return {
		items: [
			{
				id: props.call.id,
				operationId: props.operationId,
				outcome: {
					certainty: 'proven',
					completion: 'succeeded',
					kind: 'completed',
					retryClass: 'forbidden',
				},
				owningGeneration: props.owningGeneration,
				status: 'ok',
				value: props.value,
			},
		],
		ok: true,
	};
}

function selectedReleaseAsset(): (typeof gogRelease.assets)[keyof typeof gogRelease.assets] {
	if (arch === 'arm64') return gogRelease.assets.arm64;
	if (arch === 'x64') return gogRelease.assets.x64;
	throw new Error(`Pinned Gog runtime proof does not support host architecture '${arch}'.`);
}

async function sha256(filePath: string): Promise<string> {
	const digest = createHash('sha256');
	await pipeline(createReadStream(filePath), digest);
	return digest.digest('hex');
}

async function downloadFile(url: string, destinationPath: string): Promise<void> {
	const response = await fetch(url, { redirect: 'follow' });
	if (!response.ok) {
		throw new Error(`Pinned Gog release download failed with HTTP ${response.status}.`);
	}
	if (response.body === null) throw new Error('Pinned Gog release response omitted its body.');
	await pipeline(
		Readable.fromWeb(response.body),
		createWriteStream(destinationPath, { flags: 'wx' }),
	);
}

export function createPinnedGogSyntheticGoogleMediation(props: {
	readonly accessToken: string;
	readonly observedRequests: string[];
}): NonNullable<ManagedVmRequestMediation['onRequest']> {
	return async (httpRequest) => {
		const url = new URL(httpRequest.url);
		const identity = `${httpRequest.method} ${url.hostname}${url.pathname}${url.search}`;
		props.observedRequests.push(identity);
		const authorization = httpRequest.headers.get('authorization');
		if (
			authorization === `Bearer ${props.accessToken}` ||
			!/^Bearer GONDOLIN_SECRET_[0-9a-f]{48}$/u.test(authorization ?? '')
		)
			throw new Error(`Pinned Gog request lacked its non-secret OAuth placeholder: ${identity}`);
		if (
			httpRequest.method === 'GET' &&
			url.hostname === 'gmail.googleapis.com' &&
			url.pathname === '/gmail/v1/users/me/messages/message-1'
		)
			return Response.json({
				id: 'message-1',
				threadId: 'thread-1',
				labelIds: ['INBOX'],
				payload: {
					mimeType: 'text/plain',
					body: { data: Buffer.from('synthetic message').toString('base64url') },
				},
			});
		if (
			httpRequest.method === 'GET' &&
			url.hostname === 'gmail.googleapis.com' &&
			url.pathname === '/gmail/v1/users/me/settings/sendAs'
		)
			return Response.json({ sendAs: [] });
		if (
			httpRequest.method === 'POST' &&
			url.hostname === 'gmail.googleapis.com' &&
			url.pathname === '/gmail/v1/users/me/drafts'
		)
			return Response.json({ id: 'draft-1', message: { id: 'draft-message-1' } });
		if (
			httpRequest.method === 'GET' &&
			url.hostname === 'www.googleapis.com' &&
			url.pathname === '/drive/v3/files/file-1' &&
			url.searchParams.get('alt') !== 'media'
		)
			return Response.json({
				id: 'file-1',
				name: 'report.pdf',
				mimeType: 'application/pdf',
			});
		if (
			httpRequest.method === 'GET' &&
			url.hostname === 'www.googleapis.com' &&
			url.pathname === '/drive/v3/files/file-1' &&
			url.searchParams.get('alt') === 'media'
		)
			return new Response(pinnedGogPublishedFileContents);
		throw new Error(`Unmatched pinned Gog HTTP request: ${identity}`);
	};
}

export async function preparePinnedGogRuntimeArtifact(
	cacheDirectory: string,
): Promise<PinnedGogRuntimeArtifact> {
	const asset = selectedReleaseAsset();
	const releaseDirectory = path.join(cacheDirectory, `gogcli-${gogRelease.version}-${arch}`);
	const executablePath = path.join(releaseDirectory, 'gog');
	await mkdir(cacheDirectory, { recursive: true });
	{
		const temporaryArchivePath = path.join(
			cacheDirectory,
			`.${asset.archive}.${randomUUID()}.download`,
		);
		const temporaryExtractDirectory = path.join(
			cacheDirectory,
			`.gogcli-${gogRelease.version}-${arch}.${randomUUID()}.extract`,
		);
		try {
			await downloadFile(
				`https://github.com/openclaw/gogcli/releases/download/v0.38.1/${asset.archive}`,
				temporaryArchivePath,
			);
			const actualArchiveSha256 = await sha256(temporaryArchivePath);
			if (actualArchiveSha256 !== asset.sha256) {
				throw new Error(
					`Pinned Gog archive checksum mismatch: expected ${asset.sha256}, received ${actualArchiveSha256}.`,
				);
			}
			await mkdir(temporaryExtractDirectory);
			await execFileAsync('tar', ['-xzf', temporaryArchivePath, '-C', temporaryExtractDirectory]);
			await chmod(path.join(temporaryExtractDirectory, 'gog'), 0o755);
			await rename(temporaryExtractDirectory, releaseDirectory);
		} finally {
			await rm(temporaryArchivePath, { force: true });
			await rm(temporaryExtractDirectory, { force: true, recursive: true });
		}
	}
	return { directoryPath: releaseDirectory, executablePath, version: gogRelease.version };
}
