import { createHash } from 'node:crypto';

import type { ArtifactReference, PortalArtifactReadResult } from '@agent-vm/agent-portal-sdk';
import { describe, expect, it, vi } from 'vitest';

import type {
	GatewayRuntimeArtifactReadCaller,
	GatewayRuntimeArtifactReader,
} from './artifact-store.js';
import type {
	WorkspaceArtifactFileStat,
	WorkspaceArtifactFilesystemPort,
} from './workspace-artifact-publisher.js';
import {
	WorkspaceArtifactPublicationError,
	publishGatewayArtifactToWorkspace,
} from './workspace-artifact-publisher.js';

const caller = {
	principal: {
		agentId: 'sun',
		frameworkIdentity: { kind: 'hermes', profileName: 'sun' },
		profileAssignmentRevision: 'assignment-1',
		toolPortalProfileId: 'default',
	},
	surfaceClass: 'protected_uds',
} satisfies GatewayRuntimeArtifactReadCaller;

function createArtifactReader(bytes: Uint8Array): {
	readonly read: ReturnType<typeof vi.fn<GatewayRuntimeArtifactReader['read']>>;
	readonly reader: GatewayRuntimeArtifactReader;
	readonly reference: ArtifactReference;
} {
	const reference = {
		byteLength: bytes.byteLength,
		expiresAt: '2099-01-01T00:00:00.000Z',
		fingerprint: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
		id: 'artifact/with caller path characters',
		mediaType: 'application/octet-stream',
	} satisfies ArtifactReference;
	const read = vi.fn<GatewayRuntimeArtifactReader['read']>(async ({ request }) => {
		const chunk = bytes.subarray(request.offsetBytes, request.offsetBytes + request.maxBytes);
		return {
			contentBase64: Buffer.from(chunk).toString('base64'),
			offsetBytes: request.offsetBytes,
			reference,
			truncated: request.offsetBytes + chunk.byteLength < bytes.byteLength,
		};
	});
	return { read, reader: { read }, reference };
}

class MemoryWorkspaceArtifactFilesystem implements WorkspaceArtifactFilesystemPort {
	readonly directories = new Set<string>(['/workspace']);
	readonly files = new Map<string, Uint8Array>();
	readonly mkdirCalls: string[] = [];
	readonly readCalls: string[] = [];
	readonly removeCalls: string[] = [];
	readonly renameCalls: Array<{ readonly fromPath: string; readonly toPath: string }> = [];
	readonly statCalls: string[] = [];
	readonly writeCalls: Array<{ readonly bytes: Uint8Array; readonly path: string }> = [];
	cleanupFails = false;
	renameFails = false;
	writeFailure: 'none' | 'owned' | 'unconfirmed' | 'unowned' = 'none';

	async stat(props: {
		readonly path: string;
		readonly signal: AbortSignal;
	}): Promise<WorkspaceArtifactFileStat> {
		this.statCalls.push(props.path);
		if (this.directories.has(props.path)) return { kind: 'directory' };
		const bytes = this.files.get(props.path);
		return bytes === undefined
			? { kind: 'missing' }
			: { byteLength: bytes.byteLength, kind: 'file' };
	}

	async mkdir(props: {
		readonly path: string;
		readonly signal: AbortSignal;
	}): Promise<{ readonly kind: 'already-exists' | 'created' }> {
		this.mkdirCalls.push(props.path);
		if (this.directories.has(props.path) || this.files.has(props.path)) {
			return { kind: 'already-exists' };
		}
		this.directories.add(props.path);
		return { kind: 'created' };
	}

	async readFile(props: {
		readonly maximumBytes: number;
		readonly path: string;
		readonly signal: AbortSignal;
	}): Promise<Uint8Array> {
		this.readCalls.push(props.path);
		const bytes = this.files.get(props.path);
		if (bytes === undefined || bytes.byteLength > props.maximumBytes)
			throw new Error('private read');
		return bytes;
	}

	async writeFileExclusive(props: {
		readonly bytes: Uint8Array;
		readonly path: string;
		readonly signal: AbortSignal;
	}): Promise<
		| {
				readonly kind: 'failed';
				readonly temporaryFileOwnership: 'owned' | 'unconfirmed' | 'unowned';
		  }
		| { readonly kind: 'written' }
	> {
		this.writeCalls.push({ bytes: props.bytes, path: props.path });
		if (this.writeFailure !== 'none') {
			if (this.writeFailure === 'owned') this.files.set(props.path, props.bytes);
			return { kind: 'failed', temporaryFileOwnership: this.writeFailure };
		}
		if (this.files.has(props.path)) return { kind: 'failed', temporaryFileOwnership: 'unowned' };
		this.files.set(props.path, props.bytes);
		return { kind: 'written' };
	}

	async renameNoReplace(props: {
		readonly fromPath: string;
		readonly signal: AbortSignal;
		readonly toPath: string;
	}): Promise<{ readonly kind: 'destination-exists' | 'renamed' }> {
		this.renameCalls.push({ fromPath: props.fromPath, toPath: props.toPath });
		if (this.renameFails) throw new Error('private rename');
		if (this.files.has(props.toPath)) return { kind: 'destination-exists' };
		const bytes = this.files.get(props.fromPath);
		if (bytes === undefined) throw new Error('private missing source');
		this.files.set(props.toPath, bytes);
		this.files.delete(props.fromPath);
		return { kind: 'renamed' };
	}

	async removeFile(props: { readonly path: string; readonly signal: AbortSignal }): Promise<void> {
		this.removeCalls.push(props.path);
		if (this.cleanupFails) throw new Error('private cleanup');
		this.files.delete(props.path);
	}
}

interface PublisherFixture {
	readonly artifact: ReturnType<typeof createArtifactReader>;
	readonly filesystem: MemoryWorkspaceArtifactFilesystem;
	readonly publish: () => ReturnType<typeof publishGatewayArtifactToWorkspace>;
}

function publishFixture(
	props: {
		readonly bytes?: Uint8Array;
		readonly fileName?: string;
		readonly filesystem?: MemoryWorkspaceArtifactFilesystem;
		readonly signal?: AbortSignal;
		readonly assertCurrentLeaseAndAuthority?: () => Promise<void>;
		readonly cleanupDeadlineMilliseconds?: number;
	} = {},
): PublisherFixture {
	const artifact = createArtifactReader(props.bytes ?? Uint8Array.of(0, 255, 128));
	const filesystem = props.filesystem ?? new MemoryWorkspaceArtifactFilesystem();
	return {
		artifact,
		filesystem,
		publish: async () =>
			await publishGatewayArtifactToWorkspace({
				assertCurrentLeaseAndAuthority:
					props.assertCurrentLeaseAndAuthority ?? (async (): Promise<void> => {}),
				caller,
				cleanupDeadlineMilliseconds: props.cleanupDeadlineMilliseconds ?? 50,
				createTemporaryName: () => 'nonce',
				fileName: props.fileName ?? 'download.bin',
				filesystem,
				maximumBytes: 16 * 1_024 * 1_024,
				reader: artifact.reader,
				reference: artifact.reference,
				signal: props.signal ?? new AbortController().signal,
			}),
	};
}

describe('publishGatewayArtifactToWorkspace', () => {
	it.each([
		{ bytes: new Uint8Array(), title: 'empty bytes' },
		{ bytes: Uint8Array.from({ length: 256 }, (_, index) => index), title: 'arbitrary bytes' },
		{
			bytes: Uint8Array.from({ length: 96 * 1_024 }, (_, index) => index % 251),
			title: 'more than 64 KiB',
		},
	])('publishes $title beneath a server-owned artifact path', async ({ bytes }) => {
		const fixture = publishFixture({ bytes });
		const result = await fixture.publish();

		expect(result.kind).toBe('published');
		expect(result.workspacePath).toMatch(
			/^\/workspace\/\.tool-portal\/[a-f0-9]{64}\/download\.bin$/,
		);
		expect(fixture.filesystem.files.get(result.workspacePath)).toEqual(bytes);
		expect(result.workspacePath).not.toContain(fixture.artifact.reference.id);
		expect(fixture.filesystem.writeCalls[0]?.bytes).toEqual(bytes);
	});

	it('verifies the complete artifact before any workspace operation', async () => {
		const fixture = publishFixture();
		fixture.artifact.read.mockImplementation(
			async ({ request }) =>
				({
					contentBase64: 'AQID',
					offsetBytes: request.offsetBytes,
					reference: fixture.artifact.reference,
					truncated: false,
				}) satisfies PortalArtifactReadResult,
		);

		await expect(fixture.publish()).rejects.toMatchObject({ code: 'artifact-unavailable' });
		expect(fixture.filesystem.statCalls).toHaveLength(0);
		expect(fixture.filesystem.mkdirCalls).toHaveLength(0);
		expect(fixture.filesystem.writeCalls).toHaveLength(0);
	});

	it.each(['../escape', 'nested/file', 'nested\\file', '.', '..', '', 'control\0name'])(
		'rejects unsafe filename %j before reading the artifact',
		async (fileName) => {
			const fixture = publishFixture({ fileName });
			await expect(fixture.publish()).rejects.toMatchObject({ code: 'invalid-filename' });
			expect(fixture.artifact.read).not.toHaveBeenCalled();
			expect(fixture.filesystem.statCalls).toHaveLength(0);
		},
	);

	it.each([0, 60_001])(
		'rejects an unbounded cleanup deadline of %d before reading the artifact',
		async (cleanupDeadlineMilliseconds) => {
			const fixture = publishFixture({ cleanupDeadlineMilliseconds });
			await expect(fixture.publish()).rejects.toMatchObject({ code: 'publication-failed' });
			expect(fixture.artifact.read).not.toHaveBeenCalled();
		},
	);

	it('does not remove a temporary path when failed write ownership is unconfirmed', async () => {
		const filesystem = new MemoryWorkspaceArtifactFilesystem();
		filesystem.writeFailure = 'unconfirmed';
		const fixture = publishFixture({ filesystem });
		await expect(fixture.publish()).rejects.toMatchObject({ code: 'cleanup-unconfirmed' });
		expect(filesystem.removeCalls).toHaveLength(0);
	});

	it('rejects symlink publication directories', async () => {
		const fixture = publishFixture();
		fixture.filesystem.directories.delete('/workspace/.tool-portal');
		const originalStat = fixture.filesystem.stat.bind(fixture.filesystem);
		fixture.filesystem.stat = vi.fn(
			async (props): Promise<WorkspaceArtifactFileStat> =>
				props.path === '/workspace/.tool-portal'
					? { kind: 'symbolic-link' }
					: await originalStat(props),
		);
		await expect(fixture.publish()).rejects.toMatchObject({ code: 'unsafe-workspace' });
		expect(fixture.filesystem.writeCalls).toHaveLength(0);
	});

	it('reuses byte-identical completed publication without another write', async () => {
		const fixture = publishFixture();
		const first = await fixture.publish();
		const second = await fixture.publish();

		expect(first.kind).toBe('published');
		expect(second).toEqual({ kind: 'reused', workspacePath: first.workspacePath });
		expect(fixture.filesystem.writeCalls).toHaveLength(1);
		expect(fixture.filesystem.renameCalls).toHaveLength(1);
	});

	it('rejects an existing conflicting final file without replacing it', async () => {
		const fixture = publishFixture();
		const first = await fixture.publish();
		fixture.filesystem.files.set(first.workspacePath, Uint8Array.of(9));
		await expect(fixture.publish()).rejects.toMatchObject({ code: 'conflict' });
		expect(fixture.filesystem.files.get(first.workspacePath)).toEqual(Uint8Array.of(9));
	});

	it('revalidates current lease and authority immediately before commit', async () => {
		let assertions = 0;
		const fixture = publishFixture({
			assertCurrentLeaseAndAuthority: async (): Promise<void> => {
				assertions += 1;
				if (assertions === 2) throw new Error('private stale lease');
			},
		});
		await expect(fixture.publish()).rejects.toMatchObject({ code: 'authority-stale' });
		expect(fixture.filesystem.renameCalls).toHaveLength(0);
		expect(fixture.filesystem.removeCalls).toHaveLength(1);
	});

	it('cancels before workspace mutation', async () => {
		const controller = new AbortController();
		controller.abort();
		const fixture = publishFixture({ signal: controller.signal });
		await expect(fixture.publish()).rejects.toMatchObject({ code: 'cancelled' });
		expect(fixture.filesystem.writeCalls).toHaveLength(0);
	});

	it('cleans its owned temporary file when cancelled after the write', async () => {
		const controller = new AbortController();
		const filesystem = new MemoryWorkspaceArtifactFilesystem();
		const originalWrite = filesystem.writeFileExclusive.bind(filesystem);
		filesystem.writeFileExclusive = vi.fn(async (props) => {
			const result = await originalWrite(props);
			controller.abort();
			return result;
		});
		const fixture = publishFixture({ filesystem, signal: controller.signal });
		await expect(fixture.publish()).rejects.toMatchObject({ code: 'cancelled' });
		expect(filesystem.renameCalls).toHaveLength(0);
		expect(filesystem.removeCalls).toHaveLength(1);
	});

	it.each([
		{ failure: 'owned' as const, expectedCleanupCalls: 1 },
		{ failure: 'unowned' as const, expectedCleanupCalls: 0 },
	])(
		'cleans only an owned temporary file after a $failure write failure',
		async ({ expectedCleanupCalls, failure }) => {
			const filesystem = new MemoryWorkspaceArtifactFilesystem();
			filesystem.writeFailure = failure;
			const fixture = publishFixture({ filesystem });
			await expect(fixture.publish()).rejects.toMatchObject({ code: 'publication-failed' });
			expect(filesystem.removeCalls).toHaveLength(expectedCleanupCalls);
		},
	);

	it('rejects and cleans a corrupted temporary write before commit', async () => {
		const filesystem = new MemoryWorkspaceArtifactFilesystem();
		const originalWrite = filesystem.writeFileExclusive.bind(filesystem);
		filesystem.writeFileExclusive = vi.fn(async (props) => {
			const result = await originalWrite(props);
			filesystem.files.set(props.path, Uint8Array.of(9, 9, 9));
			return result;
		});
		const fixture = publishFixture({ filesystem });
		await expect(fixture.publish()).rejects.toMatchObject({ code: 'publication-failed' });
		expect(filesystem.renameCalls).toHaveLength(0);
		expect(filesystem.removeCalls).toHaveLength(1);
	});

	it('reports cleanup as unconfirmed without exposing the underlying diagnostic', async () => {
		const filesystem = new MemoryWorkspaceArtifactFilesystem();
		filesystem.renameFails = true;
		filesystem.cleanupFails = true;
		const fixture = publishFixture({ filesystem });
		let failure: unknown;
		try {
			await fixture.publish();
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(WorkspaceArtifactPublicationError);
		expect(failure).toMatchObject({ code: 'cleanup-unconfirmed' });
		expect((failure as Error).message).not.toContain('private');
	});

	it('bounds cleanup and aborts a hung cleanup operation', async () => {
		vi.useFakeTimers();
		try {
			const filesystem = new MemoryWorkspaceArtifactFilesystem();
			filesystem.renameFails = true;
			let cleanupSignalAborted = false;
			filesystem.removeFile = vi.fn(
				async ({ signal }) =>
					await new Promise<void>((_resolve, reject) => {
						signal.addEventListener(
							'abort',
							(): void => {
								cleanupSignalAborted = true;
								reject(new Error('private hung cleanup aborted'));
							},
							{ once: true },
						);
					}),
			);
			const fixture = publishFixture({ cleanupDeadlineMilliseconds: 25, filesystem });
			const publicationFailure = expect(fixture.publish()).rejects.toMatchObject({
				code: 'cleanup-unconfirmed',
			});
			await vi.advanceTimersByTimeAsync(25);
			await publicationFailure;
			expect(cleanupSignalAborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('reports a rename failure only after cleaning the owned temporary file', async () => {
		const filesystem = new MemoryWorkspaceArtifactFilesystem();
		filesystem.renameFails = true;
		const fixture = publishFixture({ filesystem });
		await expect(fixture.publish()).rejects.toMatchObject({ code: 'publication-failed' });
		expect(filesystem.removeCalls).toHaveLength(1);
		expect(filesystem.files.size).toBe(0);
	});

	it('cleans the owned temporary file when no-replace detects a commit race', async () => {
		const fixture = publishFixture();
		fixture.filesystem.renameNoReplace = vi.fn(async ({ toPath }) => {
			fixture.filesystem.files.set(toPath, Uint8Array.of(7));
			return { kind: 'destination-exists' } as const;
		});
		await expect(fixture.publish()).rejects.toMatchObject({ code: 'conflict' });
		expect(fixture.filesystem.removeCalls).toHaveLength(1);
		expect([...fixture.filesystem.files.values()]).toContainEqual(Uint8Array.of(7));
	});

	it('snapshots mutable reference, filename, and caller inputs before artifact reads await', async () => {
		const bytes = Uint8Array.of(1, 2, 3);
		const artifact = createArtifactReader(bytes);
		const filesystem = new MemoryWorkspaceArtifactFilesystem();
		const mutableReference = { ...artifact.reference };
		const mutableCaller = structuredClone(caller);
		const readCallers: GatewayRuntimeArtifactReadCaller[] = [];
		const publishProps = {
			assertCurrentLeaseAndAuthority: async (): Promise<void> => {},
			caller: mutableCaller,
			cleanupDeadlineMilliseconds: 50,
			createTemporaryName: () => 'nonce',
			fileName: 'original.bin',
			filesystem,
			maximumBytes: 16 * 1_024 * 1_024,
			reader: artifact.reader,
			reference: mutableReference,
			signal: new AbortController().signal,
		};
		artifact.read.mockImplementation(async ({ caller: readCaller, request }) => {
			readCallers.push(readCaller);
			if (readCallers.length === 1) {
				Reflect.set(publishProps, 'fileName', 'changed.bin');
				Reflect.set(mutableReference, 'id', 'changed-artifact');
				Reflect.set(mutableCaller.principal, 'agentId', 'ember');
			}
			const chunk = bytes.subarray(request.offsetBytes, request.offsetBytes + request.maxBytes);
			return {
				contentBase64: Buffer.from(chunk).toString('base64'),
				offsetBytes: request.offsetBytes,
				reference: request.reference,
				truncated: request.offsetBytes + chunk.byteLength < bytes.byteLength,
			};
		});

		const result = await publishGatewayArtifactToWorkspace(publishProps);
		const originalIdHash = createHash('sha256').update(artifact.reference.id).digest('hex');
		expect(result.workspacePath).toBe(`/workspace/.tool-portal/${originalIdHash}/original.bin`);
		expect(readCallers.every((readCaller) => readCaller.principal.agentId === 'sun')).toBe(true);
	});
});
