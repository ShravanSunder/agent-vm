import type { Readable, Writable } from 'node:stream';

import type { Transport } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import {
	NodeHostAuthenticatedEnvelopeSchema,
	type NodeHostAuthenticatedEnvelope,
} from '#node-host/mcp-proxy-server/models/bearer-credentials';
import type {
	StandaloneToolPortalArtifactReader,
	StandaloneToolPortalProjectionService,
} from '#node-host/standalone-tool-portal/models/standalone-portal-contracts';
import { createStandaloneToolPortalMcpServer } from '#node-host/standalone-tool-portal/standalone-mcp-server';

function deepFreeze<TValue>(value: TValue): TValue {
	if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

export async function startStandaloneToolPortalMcpStdioServer(props: {
	readonly artifactReader: StandaloneToolPortalArtifactReader;
	readonly authenticatedEnvelope: NodeHostAuthenticatedEnvelope;
	readonly service: StandaloneToolPortalProjectionService;
	readonly input?: Readable;
	readonly output?: Writable;
	readonly transport?: Transport;
}): Promise<{
	readonly authenticatedEnvelope: NodeHostAuthenticatedEnvelope;
	readonly retire: () => Promise<void>;
	readonly service: StandaloneToolPortalProjectionService;
}> {
	const authenticatedEnvelope = deepFreeze(
		NodeHostAuthenticatedEnvelopeSchema.parse(props.authenticatedEnvelope),
	);
	const server = serveStdio(
		() => createStandaloneToolPortalMcpServer({ ...props, authenticatedEnvelope }),
		{
			legacy: 'reject',
			transport: props.transport ?? new StdioServerTransport(props.input, props.output),
		},
	);
	return {
		authenticatedEnvelope,
		retire: async () => await server.close(),
		service: props.service,
	};
}
