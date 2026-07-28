import type { StandaloneToolPortalConfig } from '@agent-vm/config-contracts';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type {
	StandaloneToolPortalAuthenticatedEnvelope,
	StandaloneToolPortalBearerCredentialSet,
} from './standalone-tool-portal-bearer-credentials.js';
import {
	startStandaloneToolPortalHttpServer,
	type StandaloneToolPortalHttpServer,
} from './standalone-tool-portal-http-server.js';
import {
	startStandaloneToolPortalMcpHttpServer,
	type StandaloneToolPortalMcpHttpServer,
} from './standalone-tool-portal-mcp-http-server.js';
import type {
	StandaloneToolPortalArtifactReader,
	StandaloneToolPortalProjectionService,
} from './standalone-tool-portal-mcp-projection.js';
import {
	startStandaloneToolPortalMcpStdioServer,
	type StandaloneToolPortalMcpStdioServer,
} from './standalone-tool-portal-mcp-stdio-server.js';

export interface StartStandaloneToolPortalEntrypointsProps {
	readonly artifactReader: StandaloneToolPortalArtifactReader;
	readonly bearerCredentialSet?: StandaloneToolPortalBearerCredentialSet;
	readonly config: StandaloneToolPortalConfig;
	readonly service: StandaloneToolPortalProjectionService;
	readonly stdioAuthenticatedEnvelope?: StandaloneToolPortalAuthenticatedEnvelope;
	readonly stdioTransport?: Transport;
}

export interface StandaloneToolPortalEntrypoints {
	readonly http?: StandaloneToolPortalHttpServer;
	readonly mcp?: StandaloneToolPortalMcpHttpServer;
	readonly retire: () => Promise<void>;
	readonly service: StandaloneToolPortalProjectionService;
	readonly stdio?: StandaloneToolPortalMcpStdioServer;
}

function validateResolvedEntrypointIdentities(
	props: StartStandaloneToolPortalEntrypointsProps,
): void {
	if (props.bearerCredentialSet !== undefined) {
		const configuredAgentIds = Object.keys(props.config.agents);
		const credentialAgentIds = new Set(
			props.bearerCredentialSet.credentials.map(({ principal }) => principal.agentId),
		);
		if (
			credentialAgentIds.size !== configuredAgentIds.length ||
			configuredAgentIds.some((agentId) => !credentialAgentIds.has(agentId))
		) {
			throw new Error(
				'Standalone Tool Portal bearer credentials must cover the exact configured agent set.',
			);
		}
		for (const credential of props.bearerCredentialSet.credentials) {
			const agentConfig = props.config.agents[credential.principal.agentId];
			const authentication = props.config.authentication.agents[credential.principal.agentId];
			if (
				agentConfig === undefined ||
				authentication === undefined ||
				credential.credentialVersion !== authentication.credentialVersion ||
				credential.principal.toolPortalProfileId !== agentConfig.profile
			) {
				throw new Error(
					`Standalone Tool Portal resolved bearer identity does not match configured agent "${credential.principal.agentId}".`,
				);
			}
		}
	}
	const stdioConfig = props.config.entrypoints.stdio;
	if (stdioConfig !== undefined && props.stdioAuthenticatedEnvelope !== undefined) {
		const agentId = stdioConfig.authentication.agentId;
		const agentConfig = props.config.agents[agentId];
		const authentication = props.config.authentication.agents[agentId];
		const principal = props.stdioAuthenticatedEnvelope.principal;
		if (
			agentConfig === undefined ||
			authentication === undefined ||
			principal.agentId !== agentId ||
			principal.credentialVersion !== authentication.credentialVersion ||
			principal.toolPortalProfileId !== agentConfig.profile
		) {
			throw new Error('Standalone Tool Portal stdio identity does not match its configured agent.');
		}
	}
}

/** Start exactly the configured standalone entrypoints over one caller-owned service. */
export async function startStandaloneToolPortalEntrypoints(
	props: StartStandaloneToolPortalEntrypointsProps,
): Promise<StandaloneToolPortalEntrypoints> {
	if (Object.values(props.config.entrypoints).every((entrypoint) => entrypoint === undefined)) {
		throw new Error('Standalone Tool Portal must explicitly enable at least one entrypoint.');
	}
	const requiresBearerCredentials =
		props.config.entrypoints.http !== undefined || props.config.entrypoints.mcp !== undefined;
	if (requiresBearerCredentials && props.bearerCredentialSet === undefined) {
		throw new Error('Standalone Tool Portal HTTP entrypoints require resolved bearer credentials.');
	}
	if (
		props.config.entrypoints.stdio !== undefined &&
		props.stdioAuthenticatedEnvelope === undefined
	) {
		throw new Error('Standalone Tool Portal stdio requires one resolved authenticated envelope.');
	}
	validateResolvedEntrypointIdentities(props);

	let http: StandaloneToolPortalHttpServer | undefined;
	let mcp: StandaloneToolPortalMcpHttpServer | undefined;
	let stdio: StandaloneToolPortalMcpStdioServer | undefined;
	try {
		const httpConfig = props.config.entrypoints.http;
		if (httpConfig !== undefined && props.bearerCredentialSet !== undefined) {
			http = await startStandaloneToolPortalHttpServer({
				allowedHosts: httpConfig.allowedHosts,
				allowedOrigins: httpConfig.allowedOrigins,
				credentialSet: props.bearerCredentialSet,
				hostname: httpConfig.address.host,
				port: httpConfig.address.port,
				routePath: httpConfig.route,
				service: props.service,
			});
		}
		const mcpConfig = props.config.entrypoints.mcp;
		if (mcpConfig !== undefined && props.bearerCredentialSet !== undefined) {
			mcp = await startStandaloneToolPortalMcpHttpServer({
				allowedHosts: mcpConfig.allowedHosts,
				allowedOrigins: mcpConfig.allowedOrigins,
				artifactReader: props.artifactReader,
				credentialSet: props.bearerCredentialSet,
				hostname: mcpConfig.address.host,
				port: mcpConfig.address.port,
				routePath: mcpConfig.route,
				service: props.service,
			});
		}
		if (
			props.config.entrypoints.stdio !== undefined &&
			props.stdioAuthenticatedEnvelope !== undefined
		) {
			stdio = await startStandaloneToolPortalMcpStdioServer({
				artifactReader: props.artifactReader,
				authenticatedEnvelope: props.stdioAuthenticatedEnvelope,
				service: props.service,
				...(props.stdioTransport === undefined ? {} : { transport: props.stdioTransport }),
			});
		}
	} catch (error) {
		await Promise.allSettled([http?.retire(), mcp?.retire(), stdio?.retire()]);
		throw error;
	}

	let retirement: Promise<void> | undefined;
	return {
		...(http === undefined ? {} : { http }),
		...(mcp === undefined ? {} : { mcp }),
		retire: () => {
			retirement ??= Promise.all([
				http?.retire({ drainTimeoutMs: props.config.drain.timeoutMs }),
				mcp?.retire({ drainTimeoutMs: props.config.drain.timeoutMs }),
				stdio?.retire(),
			]).then(() => undefined);
			return retirement;
		},
		service: props.service,
		...(stdio === undefined ? {} : { stdio }),
	};
}
