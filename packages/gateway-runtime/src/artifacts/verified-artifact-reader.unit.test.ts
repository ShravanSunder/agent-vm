import { createHash } from 'node:crypto';

import type { ArtifactReference, PortalArtifactReadResult } from '@agent-vm/agent-portal-sdk';
import { describe, expect, it, vi } from 'vitest';

import type {
	GatewayRuntimeArtifactReadCaller,
	GatewayRuntimeArtifactReader,
} from './artifact-store.js';
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

function createFixture(bytes: Uint8Array): {
	readonly reader: GatewayRuntimeArtifactReader;
	readonly read: ReturnType<typeof vi.fn<GatewayRuntimeArtifactReader['read']>>;
	readonly reference: ArtifactReference;
} {
	const reference = {
		byteLength: bytes.byteLength,
		expiresAt: '2099-01-01T00:00:00.000Z',
		fingerprint: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
		id: 'test-artifact',
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

function readFixture(
	fixture: ReturnType<typeof createFixture>,
	signal = new AbortController().signal,
): Promise<Uint8Array> {
	return readVerifiedGatewayArtifact({
		caller,
		chunkBytes: 17,
		maximumBytes: 1_024,
		reader: fixture.reader,
		reference: fixture.reference,
		signal,
	});
}

describe('readVerifiedGatewayArtifact', () => {
	it.each([new Uint8Array(), Uint8Array.from({ length: 256 }, (_, index) => index)])(
		'preserves complete binary bytes and scoped ranged reads (%#)',
		async (bytes) => {
			const fixture = createFixture(bytes);
			const result = await readFixture(fixture);
			expect(result).toEqual(bytes);
			for (const [request] of fixture.read.mock.calls) {
				expect(request.caller).toEqual(caller);
				expect(request.request.maxBytes).toBeLessThanOrEqual(17);
			}
			expect(fixture.read.mock.lastCall?.[0].request.offsetBytes).toBe(bytes.byteLength);
		},
	);

	it('rejects excessive length before reading or allocating file contents', async () => {
		const fixture = createFixture(new Uint8Array(1_025));
		await expect(readFixture(fixture)).rejects.toMatchObject({ code: 'size-limit' });
		expect(fixture.read).not.toHaveBeenCalled();
	});

	it.each([
		{
			title: 'noncanonical base64',
			mutate: (value: PortalArtifactReadResult): PortalArtifactReadResult => ({
				...value,
				contentBase64: 'AA==\n',
			}),
		},
		{
			title: 'wrong offset',
			mutate: (value: PortalArtifactReadResult): PortalArtifactReadResult => ({
				...value,
				offsetBytes: 1,
			}),
		},
		{
			title: 'early EOF',
			mutate: (value: PortalArtifactReadResult): PortalArtifactReadResult => ({
				...value,
				contentBase64: '',
				truncated: false,
			}),
		},
		{
			title: 'changed reference',
			mutate: (value: PortalArtifactReadResult): PortalArtifactReadResult => ({
				...value,
				reference: { ...value.reference, id: 'other-artifact' },
			}),
		},
		{
			title: 'false completion',
			mutate: (value: PortalArtifactReadResult): PortalArtifactReadResult => ({
				...value,
				truncated: true,
			}),
		},
	])('rejects $title without returning a partial file', async ({ mutate }) => {
		const fixture = createFixture(Uint8Array.of(0, 255, 128));
		const original = fixture.read.getMockImplementation();
		if (original === undefined) throw new Error('Fixture reader missing.');
		fixture.read.mockImplementation(async (request) => mutate(await original(request)));
		await expect(readFixture(fixture)).rejects.toMatchObject({ code: 'integrity' });
	});

	it('checks the actual content hash rather than trusting returned metadata', async () => {
		const fixture = createFixture(Uint8Array.of(0, 255, 128));
		fixture.read.mockResolvedValue({
			contentBase64: 'AQID',
			offsetBytes: 0,
			reference: fixture.reference,
			truncated: false,
		});
		await expect(readFixture(fixture)).rejects.toMatchObject({ code: 'integrity' });
	});

	it('checks current authority again after the last content chunk', async () => {
		const fixture = createFixture(Uint8Array.of(1, 2, 3));
		const original = fixture.read.getMockImplementation();
		if (original === undefined) throw new Error('Fixture reader missing.');
		fixture.read.mockImplementation(async (request) => {
			if (request.request.offsetBytes === 3) throw new Error('private diagnostic');
			return await original(request);
		});
		await expect(readFixture(fixture)).rejects.toMatchObject({ code: 'unavailable' });
		await expect(readFixture(fixture)).rejects.not.toThrow('private diagnostic');
	});

	it('cancels a pending read without publishing bytes', async () => {
		const fixture = createFixture(Uint8Array.of(1));
		fixture.read.mockImplementation(
			async () => await new Promise<PortalArtifactReadResult>(() => {}),
		);
		const controller = new AbortController();
		const pending = readFixture(fixture, controller.signal);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
	});

	it('does not read after cancellation before entry', async () => {
		const fixture = createFixture(Uint8Array.of(1));
		const controller = new AbortController();
		controller.abort();
		await expect(readFixture(fixture, controller.signal)).rejects.toMatchObject({
			code: 'cancelled',
		});
		expect(fixture.read).not.toHaveBeenCalled();
	});
});
