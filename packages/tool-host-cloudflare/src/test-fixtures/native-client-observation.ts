import type { UpstreamMcpClientLike } from '@agent-collaboration/tool-engine/connectors';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export const nativeClientClosures: { readonly id: number; closed: number }[] = [];
function isNativeTransport(value: unknown): value is Transport {
	return (
		typeof value === 'object' &&
		value !== null &&
		'start' in value &&
		typeof value.start === 'function' &&
		'send' in value &&
		typeof value.send === 'function' &&
		'close' in value &&
		typeof value.close === 'function'
	);
}
/** Test observation only: every protocol call and transport stays the real, unchanged SDK. */
export function createObservedNativeClient(): UpstreamMcpClientLike {
	const client = new Client({ name: 'mcp-portal', version: '1.0.0' });
	const observation = { id: nativeClientClosures.length, closed: 0 };
	nativeClientClosures.push(observation);
	return {
		connect: async (transport, options) => {
			if (!isNativeTransport(transport)) throw new Error('Missing native transport.');
			await client.connect(transport, options);
		},
		callTool: async (params, _schema, options) => client.callTool(params, undefined, options),
		listTools: async (params, options) => client.listTools(params, options),
		close: async () => {
			observation.closed += 1;
			await client.close();
		},
	};
}
