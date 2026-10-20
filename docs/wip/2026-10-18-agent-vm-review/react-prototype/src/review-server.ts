import { readFile, appendFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

import { initialReviewState, reviewCommandSchema, type ReviewState } from './review-contracts.js';

let currentState: ReviewState = structuredClone(initialReviewState);
const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
function sendJson(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
	response.end(JSON.stringify(value));
}
async function readJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request)
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
	const requestUrl = new URL(request.url ?? '/', 'http://localhost');
	if (request.method === 'GET' && requestUrl.pathname === '/api/review')
		return sendJson(response, 200, currentState);
	if (request.method === 'POST' && requestUrl.pathname === '/api/review') {
		const parsed = reviewCommandSchema.safeParse(await readJson(request));
		if (!parsed.success)
			return sendJson(response, 400, {
				kind: 'rejected',
				message: parsed.error.issues[0]?.message ?? 'Check the form.',
			});
		if (request.headers['x-review-scenario'] === 'unavailable')
			return sendJson(response, 503, {
				kind: 'rejected',
				message:
					'The configuration service is unavailable. Your changes are still here. Try again.',
			});
		const command = parsed.data;
		if (command.revision !== currentState.revision)
			return sendJson(response, 409, {
				kind: 'rejected',
				message: 'The workspace changed in another window. Reload before saving again.',
			});
		let action: string;
		let subject: string;
		let before: string;
		let after: string;
		switch (command.kind) {
			case 'workspace-tools':
				action = 'Workspace tools changed';
				subject = 'Studio workspace';
				before = currentState.workspaceToolIds.join(', ');
				after = command.toolIds.join(', ');
				currentState = {
					...currentState,
					workspaceToolIds: command.toolIds,
					agents: currentState.agents.map((agent): ReviewState['agents'][number] => ({
						...agent,
						toolIds: agent.toolIds.filter((id): boolean => command.toolIds.includes(id)),
					})),
				};
				break;
			case 'register-agent':
				if (command.toolIds.some((id): boolean => !currentState.workspaceToolIds.includes(id)))
					return sendJson(response, 403, {
						kind: 'rejected',
						message: 'An agent can only receive tools available in this workspace.',
					});
				if (
					currentState.agents.some(
						(agent): boolean => agent.name.toLowerCase() === command.name.toLowerCase(),
					)
				)
					return sendJson(response, 409, {
						kind: 'rejected',
						message: 'An agent with this name already exists. Choose a different name.',
					});
				action = 'Agent registered';
				subject = command.name;
				before = 'Not registered';
				after = command.toolIds.join(', ') || 'No resource tools';
				currentState = {
					...currentState,
					agents: [
						...currentState.agents,
						{
							id: crypto.randomUUID(),
							name: command.name,
							harness: command.harness,
							toolIds: command.toolIds,
						},
					],
				};
				break;
			case 'confirm-account':
				action = 'Team account confirmed';
				subject = command.alias;
				before = currentState.account.kind;
				after = 'Connected to Studio workspace';
				currentState = { ...currentState, account: { kind: 'connected', alias: command.alias } };
				break;
			case 'cancel-account':
				action = 'Account connection cancelled';
				subject = 'Team Google account';
				before = currentState.account.kind;
				after = 'Cancelled';
				currentState = { ...currentState, account: { kind: 'cancelled' } };
				break;
		}
		const auditEvent = {
			id: crypto.randomUUID(),
			action,
			subject,
			before,
			after,
			actor: 'Demo workspace manager',
			time: new Date().toISOString(),
		};
		currentState = {
			...currentState,
			revision: currentState.revision + 1,
			auditEvents: [auditEvent, ...currentState.auditEvents],
		};
		await appendFile(
			new URL('../review-events.jsonl', import.meta.url),
			`${JSON.stringify({ command, auditEvent })}\n`,
		);
		return sendJson(response, 200, { kind: 'saved', state: currentState });
	}
	const paths: Readonly<Record<string, readonly [string, string]>> = {
		'/': ['index.html', 'text/html'],
		'/app.js': ['app.js', 'text/javascript'],
		'/app.css': ['app.css', 'text/css'],
	};
	const file = paths[requestUrl.pathname];
	if (request.method !== 'GET' || !file) {
		response.writeHead(404);
		response.end('Not found');
		return;
	}
	response.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-store' });
	response.end(await readFile(`${publicRoot}${file[0]}`));
}
const server = createServer((request, response): void => {
	handleRequest(request, response).catch((error: unknown): void => {
		console.error(error);
		if (!response.headersSent)
			sendJson(response, 500, {
				kind: 'rejected',
				message: 'The review fixture could not process this request.',
			});
		else response.end();
	});
});
server.listen(0, '127.0.0.1', (): void => {
	const address = server.address();
	if (address && typeof address !== 'string')
		console.log(`REVIEW_READY http://127.0.0.1:${address.port}/`);
});
