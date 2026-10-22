import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

import { startStandaloneToolPortalMcpStdioServer } from '../../../packages/tool-host-node/dist/index.js';
import { StdioServerTransport } from '../../../packages/tool-host-node/src/test-fixtures/old-stdio-server-transport.js';
import {
	createStandaloneHostFixture,
	standaloneCredentials,
} from '../../../packages/tool-host-node/src/test-fixtures/standalone-host-fixture.js';
import { createStandaloneToolPortalMcpServer } from '../../../packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-mcp-projection.js';

// A retained process fixture: only the bytes authored by the actual SDK server are gated.
const mode = process.argv[2];
if (mode !== 'old' && mode !== 'modern') throw new Error('Expected old or modern fixture mode.');
const providerUrl = new URL(process.argv[3] ?? '').href;
const controlUrl = new URL(process.argv[4] ?? '').href;
const fixture = await createStandaloneHostFixture({ url: providerUrl });
const principal = standaloneCredentials.credentials[0];
if (principal === undefined) throw new Error('Missing scoped fixture principal.');
const authenticatedEnvelope = {
	audience: standaloneCredentials.audience,
	serviceGeneration: standaloneCredentials.serviceGeneration,
	principal: { ...principal.principal, credentialVersion: principal.credentialVersion },
};
const event = async (name: string): Promise<void> => {
	const response = await fetch(new URL(name, controlUrl), { method: 'POST' });
	if (!response.ok) throw new Error(`Control event failed: ${name}`);
	await response.text();
};
let held = '';
let holdResult = true;
const output = new Writable({
	write(chunk: Buffer, _encoding, callback): void {
		const text = chunk.toString('utf8');
		if (holdResult && text.includes('"id":"grace"') && text.includes('"structuredContent"')) {
			held += text;
			holdResult = false;
			callback();
			void event('held');
		} else process.stdout.write(chunk, callback);
	},
});
const props = {
	artifactReader: fixture.artifactReader,
	authenticatedEnvelope,
	service: fixture.service,
};
const server =
	mode === 'modern'
		? await startStandaloneToolPortalMcpStdioServer({ ...props, input: process.stdin, output })
		: await (async () => {
				const old = createStandaloneToolPortalMcpServer({
					...props,
					sessionId: 'standalone-scoped-stdio',
				});
				await old.connect(new StdioServerTransport(process.stdin, output));
				return { retire: async (): Promise<void> => old.close() };
			})();
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
	const message: unknown = JSON.parse(line);
	if (
		typeof message === 'object' &&
		message !== null &&
		'method' in message &&
		message.method === 'notifications/cancelled'
	) {
		void (async () => {
			await event('cancelled');
			process.stdout.write(held);
			held = '';
		})();
	}
});
process.stdin.once('end', () => {
	void (async () => {
		lines.close();
		await server.retire();
		await fixture.close();
		output.end();
	})();
});
await event('ready');
