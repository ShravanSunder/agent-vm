import type { Readable, Writable } from 'node:stream';

import type { ApprovalPort } from '@agent-collaboration/tool-engine/dispatch';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { loadNodeHostConfig } from '#node-host/configuration/node-host-config';
import { compileNodeHostCredentialSet } from '#node-host/ingress/bearer-credentials';
import {
	startNodeHostMcpHttpServer,
	type NodeHostMcpHttpServer,
} from '#node-host/ingress/node-http-server';
import { createNodeMcpServer } from '#node-host/ingress/node-mcp-server';
import {
	createNodeHostComposition,
	type NodeHostComposition,
	type NodeHostSecretResolutionPort,
} from '#node-host/node-host-composition';

export interface RunningNodeHost {
	readonly composition: NodeHostComposition;
	readonly http?: NodeHostMcpHttpServer;
	readonly retire: () => Promise<void>;
}

export async function startNodeHost(props: {
	readonly configPath: string;
	readonly secrets: NodeHostSecretResolutionPort;
	readonly approvals?: ApprovalPort;
	readonly approvalKeysByAgent?: ReadonlyMap<string, Uint8Array>;
	readonly input?: Readable;
	readonly output?: Writable;
	readonly onDiagnostic?: (event: string) => void;
}): Promise<RunningNodeHost> {
	const config = await loadNodeHostConfig(props.configPath);
	const composition = await createNodeHostComposition({
		config,
		secrets: props.secrets,
		...(props.approvalKeysByAgent === undefined
			? {}
			: { approvalKeysByAgent: props.approvalKeysByAgent }),
		...(props.approvals === undefined ? {} : { approvals: props.approvals }),
		...(props.onDiagnostic === undefined ? {} : { onDiagnostic: props.onDiagnostic }),
	});
	try {
		if (config.listener.kind === 'http') {
			const http = await startNodeHostMcpHttpServer({
				...config.listener,
				composition,
				credentialSet: config.auth,
				exposure: config.exposure,
				...(props.onDiagnostic === undefined ? {} : { onDiagnostic: props.onDiagnostic }),
			});
			return {
				composition,
				http,
				retire: async () => {
					try {
						await http.retire();
					} finally {
						await composition.close();
					}
				},
			};
		}
		const agentId = config.listener.agentId;
		const credential = compileNodeHostCredentialSet(config.auth).credentials.find(
			(entry) => entry.principal.agentId === agentId,
		);
		if (credential === undefined) throw new Error('Missing stdio identity.');
		const server = serveStdio(
			() => createNodeMcpServer({ gateway: composition.gatewayFor(credential), mode: 'indirect' }),
			{ legacy: 'reject', transport: new StdioServerTransport(props.input, props.output) },
		);
		let retirement: Promise<void> | undefined;
		const retire = (): Promise<void> => {
			retirement ??= (async () => {
				try {
					await server.close();
				} finally {
					await composition.close();
				}
			})();
			return retirement;
		};
		const input = props.input ?? process.stdin;
		input.once('end', () => {
			void retire().catch(() => props.onDiagnostic?.('server-failed'));
		});
		return { composition, retire };
	} catch (error) {
		await composition.close();
		throw error;
	}
}
