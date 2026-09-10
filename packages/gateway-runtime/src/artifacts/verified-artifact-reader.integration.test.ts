import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ArtifactReference } from '@agent-vm/agent-portal-sdk';
import { describe, expect, it } from 'vitest';

import {
	createGatewayRuntimeArtifactCurrentAuthorityRegistry,
	createGatewayRuntimeArtifactReadAuthorityResolver,
	type GatewayRuntimeArtifactReadCaller,
} from './artifact-read-authority.js';
import { createGatewayRuntimeArtifactStore } from './artifact-store.js';
import { createGatewayRuntimeFileArtifactStorageBackend } from './runtime-file-artifact-storage.js';
import { readVerifiedGatewayArtifact } from './verified-artifact-reader.js';

const caller = {
	principal: {
		agentId: 'sun',
		frameworkIdentity: { kind: 'hermes', profileName: 'sun' },
		profileAssignmentRevision: 'assignment-1',
		toolPortalProfileId: 'default',
	},
	surfaceClass: 'protected_uds',
} satisfies GatewayRuntimeArtifactReadCaller;

async function createFixture(bytes: Uint8Array): Promise<{
	readonly close: () => Promise<void>;
	readonly corrupt: () => Promise<void>;
	readonly read: (readCaller?: GatewayRuntimeArtifactReadCaller) => Promise<Uint8Array>;
	readonly reference: ArtifactReference;
	readonly retire: () => void;
}> {
	const root = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-verified-artifact-'));
	try {
		const registry = createGatewayRuntimeArtifactCurrentAuthorityRegistry();
		const authorization = {
			...caller.principal,
			capability: { name: 'download', namespace: 'google' },
			executionFingerprint: 'execution-1',
			operationId: 'operation-1',
			owningGeneration: 'generation-1',
			surfaceClass: caller.surfaceClass,
		};
		registry.register(authorization);
		const store = createGatewayRuntimeArtifactStore({
			authorityResolver: createGatewayRuntimeArtifactReadAuthorityResolver({
				currentAuthority: registry.currentAuthority,
			}),
			epochId: 'epoch-1',
			limits: {
				maximumArtifactBytes: 1_048_576,
				maximumArtifactCount: 4,
				maximumLifetimeMs: 60_000,
				maximumTotalBytes: 4_194_304,
			},
			now: () => 0,
			storageBackend: await createGatewayRuntimeFileArtifactStorageBackend({
				artifactsDirectoryPath: root,
			}),
		});
		const writer = await store.beginWrite({
			authorization,
			lifetimeMs: 60_000,
			maximumBytes: Math.max(1, bytes.byteLength),
		});
		await writer.write(bytes);
		const reference = await writer.commit();
		return {
			close: async (): Promise<void> => {
				try {
					await store.retireEpoch();
				} finally {
					await rm(root, { force: true, recursive: true });
				}
			},
			corrupt: async (): Promise<void> => {
				await writeFile(path.join(root, reference.id), new Uint8Array(bytes.byteLength));
			},
			read: async (readCaller = caller): Promise<Uint8Array> =>
				await readVerifiedGatewayArtifact({
					caller: readCaller,
					maximumBytes: 1_048_576,
					reader: store,
					reference,
					signal: new AbortController().signal,
				}),
			reference,
			retire: (): void => {
				registry.retire({ kind: 'operation', operationId: authorization.operationId });
			},
		};
	} catch (error) {
		await rm(root, { force: true, recursive: true });
		throw error;
	}
}

describe('verified file-backed artifact reads', () => {
	it('returns exact binary bytes larger than an inline Portal string', async () => {
		const bytes = Uint8Array.from({ length: 256 * 1_024 }, (_, index) => index % 256);
		const fixture = await createFixture(bytes);
		try {
			const result = await fixture.read();
			expect(result).toEqual(bytes);
			expect(fixture.reference.byteLength).toBe(bytes.byteLength);
		} finally {
			await fixture.close();
		}
	});

	it('rejects bytes corrupted on disk even when stored identity metadata is unchanged', async () => {
		const fixture = await createFixture(Uint8Array.of(1, 2, 255));
		try {
			await fixture.corrupt();
			await expect(fixture.read()).rejects.toMatchObject({ code: 'integrity' });
		} finally {
			await fixture.close();
		}
	});

	it('keeps cross-agent and retired-operation reads unavailable', async () => {
		const fixture = await createFixture(Uint8Array.of(1, 2, 255));
		try {
			await expect(
				fixture.read({ ...caller, principal: { ...caller.principal, agentId: 'ember' } }),
			).rejects.toMatchObject({ code: 'unavailable' });
			fixture.retire();
			await expect(fixture.read()).rejects.toMatchObject({ code: 'unavailable' });
		} finally {
			await fixture.close();
		}
	});
});
