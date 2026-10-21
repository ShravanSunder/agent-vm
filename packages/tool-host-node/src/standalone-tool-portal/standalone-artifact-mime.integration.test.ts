import { PortalArtifactReadResultSchema } from '@agent-collaboration/tool-access/contracts';
import { createPortalArtifactReadResourceRequest } from '@agent-vm/agent-portal-sdk';
import { ToolPortalMcpClient } from '@agent-vm/agent-portal-sdk/tool-portal-mcp-client';
import { createNodeToolPortalMcpTransport } from '@agent-vm/agent-portal-sdk/tool-portal-mcp-client/node-transport';
import { startStandaloneToolPortalMcpHttpServer as startOldMcp } from '@agent-vm/tool-portal';
import { expect, it } from 'vitest';

import type { StandaloneToolPortalArtifactReader } from '#node-host/standalone-tool-portal/models/standalone-portal-contracts';
import { startStandaloneToolPortalMcpHttpServer } from '#node-host/standalone-tool-portal/standalone-http-servers';
import { startControlledProvider } from '#node-host/test-fixtures/node-host-fixture';
import { createNodeToolPortalMcpTransport as createOldTransport } from '#node-host/test-fixtures/old-node-tool-portal-mcp-transport';
import {
	createStandaloneHostFixture,
	standaloneCredentials,
} from '#node-host/test-fixtures/standalone-host-fixture';

it('preserves the pre-existing old/new SDK rejection of schema-valid artifact bytes without MIME', async () => {
	const provider = await startControlledProvider('mime-parity');
	const fixture = await createStandaloneHostFixture(provider);
	const { mediaType: _mediaType, ...reference } = fixture.reference;
	let reads = 0;
	// A controlled artifact authority returns a schema-valid optional-MIME result. The real
	// MCP servers, old/current SDK transports, and high-level SDK validation remain intact.
	const artifactReader: StandaloneToolPortalArtifactReader = {
		read: async ({ caller, request }) => {
			expect(caller.authenticatedEnvelope.principal.agentId).toBe('agent-a');
			expect(request.reference).toEqual(reference);
			reads++;
			return PortalArtifactReadResultSchema.parse({
				reference,
				offsetBytes: 0,
				contentBase64: fixture.artifactBytes.toString('base64'),
				truncated: false,
			});
		},
	};
	const common = {
		hostname: '127.0.0.1',
		port: 0,
		routePath: '/portal',
		allowedHosts: ['127.0.0.1'],
		allowedOrigins: [],
		credentialSet: standaloneCredentials,
		service: fixture.service,
		artifactReader,
	};
	const old = await startOldMcp(common);
	const current = await startStandaloneToolPortalMcpHttpServer(common);
	const oldTransport = createOldTransport({
		kind: 'http',
		endpoint: old.endpoint,
		authorization: 'credential-agent-a',
	});
	const transport = createNodeToolPortalMcpTransport({
		kind: 'http',
		endpoint: current.endpoint,
		authorization: 'credential-agent-a',
	});
	const oldClient = new ToolPortalMcpClient({ transport: oldTransport });
	const client = new ToolPortalMcpClient({ transport });
	const request = { reference, offsetBytes: 0, maxBytes: 8 };
	try {
		await Promise.all([oldClient.connect(), client.connect()]);
		const resource = createPortalArtifactReadResourceRequest(request);
		const oldBytes = await oldTransport.readResource(resource);
		const bytes = await transport.readResource(resource);
		expect(bytes).toEqual(oldBytes);
		expect(bytes.contents).toEqual([
			{ kind: 'blob', uri: resource.uri, blob: fixture.artifactBytes.toString('base64') },
		]);
		const oldError: unknown = await oldClient.artifacts
			.read(request)
			.catch((error: unknown) => error);
		const currentError: unknown = await client.artifacts
			.read(request)
			.catch((error: unknown) => error);
		expect(oldError).toBeInstanceOf(TypeError);
		expect(currentError).toBeInstanceOf(TypeError);
		if (!(oldError instanceof Error) || !(currentError instanceof Error))
			throw new Error('Expected matching SDK errors.');
		expect(currentError.message).toBe(oldError.message);
		expect(currentError.message).toBe(
			'Tool Portal MCP artifact read returned an invalid resource.',
		);
		expect(reads).toBe(4);
		expect(provider.effects).toHaveLength(0);
		process.stdout.write(
			JSON.stringify({
				case: 'optional artifact MIME parity',
				old: oldError.message,
				current: currentError.message,
				reads,
				effects: provider.effects.length,
			}) + '\n',
		);
	} finally {
		await Promise.all([oldClient.close(), client.close()]);
		await Promise.all([old.retire(), current.retire()]);
		await fixture.close();
		await provider.close();
	}
});
