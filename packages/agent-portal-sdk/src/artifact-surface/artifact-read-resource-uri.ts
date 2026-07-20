import { z } from 'zod';

import {
	PortalArtifactReadRequestSchema,
	type PortalArtifactReadRequest,
} from './models/portal-artifact-contract-schema.js';

export const PORTAL_ARTIFACT_READ_REQUEST_META_KEY = 'agent-vm/artifact-read-request';

const artifactReadResourceProtocol = 'agent-vm-artifact:';
const artifactReadResourceHost = 'read';

export const PortalArtifactReadResourceRequestSchema = z
	.object({
		_meta: z
			.object({
				[PORTAL_ARTIFACT_READ_REQUEST_META_KEY]: PortalArtifactReadRequestSchema,
			})
			.strict(),
		uri: z.string().min(1),
	})
	.strict();

export type PortalArtifactReadResourceRequest = z.infer<
	typeof PortalArtifactReadResourceRequestSchema
>;

function createOpaqueArtifactResourceUri(artifactId: string): string {
	const resourceUri = new URL(`${artifactReadResourceProtocol}//${artifactReadResourceHost}`);
	resourceUri.searchParams.set('id', artifactId);
	return resourceUri.toString();
}

function parseOpaqueArtifactResourceId(uri: string): string {
	const resourceUri = new URL(uri);
	if (
		resourceUri.protocol !== artifactReadResourceProtocol ||
		resourceUri.hostname !== artifactReadResourceHost ||
		resourceUri.port.length > 0 ||
		resourceUri.username.length > 0 ||
		resourceUri.password.length > 0 ||
		(resourceUri.pathname.length > 0 && resourceUri.pathname !== '/') ||
		resourceUri.hash.length > 0 ||
		[...resourceUri.searchParams.keys()].some((parameterName) => parameterName !== 'id')
	) {
		throw new TypeError('Artifact read resource URI has an invalid origin or field.');
	}
	const artifactIds = resourceUri.searchParams.getAll('id');
	if (artifactIds.length !== 1 || artifactIds[0] === undefined || artifactIds[0].length === 0) {
		throw new TypeError('Artifact read resource URI requires one opaque artifact identifier.');
	}
	return artifactIds[0];
}

/** Build one standard MCP read request whose URI exposes only the opaque artifact ID. */
export function createPortalArtifactReadResourceRequest(
	request: PortalArtifactReadRequest,
): PortalArtifactReadResourceRequest {
	const parsedRequest = PortalArtifactReadRequestSchema.parse(request);
	return PortalArtifactReadResourceRequestSchema.parse({
		_meta: { [PORTAL_ARTIFACT_READ_REQUEST_META_KEY]: parsedRequest },
		uri: createOpaqueArtifactResourceUri(parsedRequest.reference.id),
	});
}

/** Recover and validate the complete public read request from standard MCP params. */
export function parsePortalArtifactReadResourceRequest(
	resourceRequest: unknown,
): PortalArtifactReadRequest {
	const parsedResourceRequest = PortalArtifactReadResourceRequestSchema.parse(resourceRequest);
	// oxlint-disable-next-line no-underscore-dangle -- `_meta` is the standard MCP protocol field name.
	const publicRequest = parsedResourceRequest._meta[PORTAL_ARTIFACT_READ_REQUEST_META_KEY];
	if (parseOpaqueArtifactResourceId(parsedResourceRequest.uri) !== publicRequest.reference.id) {
		throw new TypeError('Artifact read resource URI does not match its public request.');
	}
	return publicRequest;
}
