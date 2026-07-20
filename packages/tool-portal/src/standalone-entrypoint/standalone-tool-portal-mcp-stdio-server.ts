import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import {
	StandaloneToolPortalAuthenticatedEnvelopeSchema,
	type StandaloneToolPortalAuthenticatedEnvelope,
} from './standalone-tool-portal-bearer-credentials.js';
import {
	createStandaloneToolPortalMcpServer,
	type StandaloneToolPortalArtifactReader,
	type StandaloneToolPortalProjectionService,
} from './standalone-tool-portal-mcp-projection.js';

export interface StartStandaloneToolPortalMcpStdioServerProps {
	readonly artifactReader: StandaloneToolPortalArtifactReader;
	readonly authenticatedEnvelope: StandaloneToolPortalAuthenticatedEnvelope;
	readonly service: StandaloneToolPortalProjectionService;
	readonly transport?: Transport;
}

export interface StandaloneToolPortalMcpStdioServer {
	readonly authenticatedEnvelope: StandaloneToolPortalAuthenticatedEnvelope;
	readonly retire: () => Promise<void>;
	readonly service: StandaloneToolPortalProjectionService;
}

function deepFreeze<TValue>(value: TValue): TValue {
	if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

/** Project one existing standalone ToolPortalService over one immutable-principal stdio channel. */
export async function startStandaloneToolPortalMcpStdioServer(
	props: StartStandaloneToolPortalMcpStdioServerProps,
): Promise<StandaloneToolPortalMcpStdioServer> {
	const authenticatedEnvelope = deepFreeze(
		StandaloneToolPortalAuthenticatedEnvelopeSchema.parse(props.authenticatedEnvelope),
	);
	const mcpServer = createStandaloneToolPortalMcpServer({
		artifactReader: props.artifactReader,
		authenticatedEnvelope,
		service: props.service,
		sessionId: 'standalone-scoped-stdio',
	});
	await mcpServer.connect(props.transport ?? new StdioServerTransport());
	let retirement: Promise<void> | undefined;
	return {
		authenticatedEnvelope,
		retire: () => {
			retirement ??= mcpServer.close();
			return retirement;
		},
		service: props.service,
	};
}
