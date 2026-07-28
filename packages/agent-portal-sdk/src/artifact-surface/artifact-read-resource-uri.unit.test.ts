import { describe, expect, it } from 'vitest';

import {
	PORTAL_ARTIFACT_READ_REQUEST_META_KEY,
	createPortalArtifactReadResourceRequest,
	parsePortalArtifactReadResourceRequest,
} from './artifact-read-resource-uri.js';

const artifactReadRequest = {
	maxBytes: 128,
	offsetBytes: 32,
	reference: {
		byteLength: 512,
		expiresAt: '2026-07-13T18:00:00.000Z',
		fingerprint: `sha256:${'a'.repeat(64)}`,
		id: 'artifact-correlation-a',
		mediaType: 'application/octet-stream',
	},
} as const;

describe('Portal artifact MCP resource request', () => {
	it('round-trips strict public metadata while the URI exposes only the opaque artifact ID', () => {
		// Arrange / Act
		const resourceRequest = createPortalArtifactReadResourceRequest(artifactReadRequest);
		const parsed = parsePortalArtifactReadResourceRequest(resourceRequest);

		// Assert
		expect(parsed).toEqual(artifactReadRequest);
		expect(resourceRequest).toEqual({
			_meta: { [PORTAL_ARTIFACT_READ_REQUEST_META_KEY]: artifactReadRequest },
			uri: 'agent-vm-artifact://read?id=artifact-correlation-a',
		});
		for (const forbiddenValue of [
			'authority',
			'byteLength',
			'credential',
			'expiresAt',
			'fingerprint',
			'lease',
			'maxBytes',
			'mediaType',
			'offsetBytes',
			'ssh',
			'/run/',
			'/work/',
		]) {
			expect(resourceRequest.uri).not.toContain(forbiddenValue);
		}
	});

	it.each([
		{
			label: 'missing metadata',
			request: { uri: 'agent-vm-artifact://read?id=artifact-correlation-a' },
		},
		{
			label: 'unknown metadata field',
			request: {
				...createPortalArtifactReadResourceRequest(artifactReadRequest),
				_meta: {
					[PORTAL_ARTIFACT_READ_REQUEST_META_KEY]: artifactReadRequest,
					authority: 'forged',
				},
			},
		},
		{
			label: 'URI and reference ID mismatch',
			request: {
				...createPortalArtifactReadResourceRequest(artifactReadRequest),
				uri: 'agent-vm-artifact://read?id=artifact-correlation-b',
			},
		},
		{
			label: 'duplicate URI identifier',
			request: {
				...createPortalArtifactReadResourceRequest(artifactReadRequest),
				uri: 'agent-vm-artifact://read?id=artifact-correlation-a&id=artifact-correlation-b',
			},
		},
		{
			label: 'path-bearing URI',
			request: {
				...createPortalArtifactReadResourceRequest(artifactReadRequest),
				uri: 'agent-vm-artifact://read/work?id=artifact-correlation-a',
			},
		},
	])('rejects $label', ({ request }) => {
		// Arrange / Act
		const parse = (): unknown => parsePortalArtifactReadResourceRequest(request);

		// Assert
		expect(parse).toThrow();
	});
});
