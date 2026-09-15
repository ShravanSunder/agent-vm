import type { ToolPortalMcpClient } from '../tool-portal-mcp-client/index.js';

/** Connect only to the current managed execution; never discover host authority. */
export async function connectToolPortal(): Promise<ToolPortalMcpClient> {
	const [{ createLocalToolPortalTransport }, { ToolPortalMcpClient }] = await Promise.all([
		import('./local-transport.js'),
		import('../tool-portal-mcp-client/index.js'),
	]);
	const client = new ToolPortalMcpClient({
		transport: createLocalToolPortalTransport({ environment: process.env }),
	});
	try {
		await client.connect();
		return client;
	} catch (error: unknown) {
		await client.close();
		throw error;
	}
}
