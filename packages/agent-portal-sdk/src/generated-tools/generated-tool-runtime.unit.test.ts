import { describe, expect, it, vi } from 'vitest';

import {
	ToolPortalMcpClient,
	type ToolPortalMcpTransport,
} from '../tool-portal-mcp-client/index.js';
import {
	GeneratedToolSchemaValidationUnavailableError,
	createGeneratedToolFunction,
	type GeneratedToolDefinition,
} from './generated-tool-runtime.js';

function createClient(): {
	readonly calls: ReturnType<typeof vi.fn<ToolPortalMcpTransport['callTool']>>;
	readonly close: ReturnType<typeof vi.fn<ToolPortalMcpTransport['close']>>;
	readonly client: ToolPortalMcpClient;
	readonly connect: ReturnType<typeof vi.fn<ToolPortalMcpTransport['connect']>>;
} {
	const calls = vi.fn<ToolPortalMcpTransport['callTool']>().mockResolvedValue({
		structuredContent: {
			auditCorrelationId: 'audit-1',
			items: [
				{
					id: 'generated-1',
					operationId: 'operation-1',
					outcome: {
						certainty: 'proven',
						completion: 'succeeded',
						kind: 'completed',
						retryClass: 'forbidden',
					},
					owningGeneration: 'generation-1',
					status: 'ok',
					value: { messages: ['hello'] },
				},
			],
			ok: true,
		},
	});
	const close = vi.fn<ToolPortalMcpTransport['close']>();
	const connect = vi.fn<ToolPortalMcpTransport['connect']>();
	const transport: ToolPortalMcpTransport = {
		callTool: calls,
		close,
		connect,
		readResource: vi.fn<ToolPortalMcpTransport['readResource']>(),
	};
	return { calls, client: new ToolPortalMcpClient({ transport }), close, connect };
}

const localDefinition = {
	diagnostics: [],
	inputSchema: {
		additionalProperties: false,
		properties: { query: { minLength: 1, type: 'string' } },
		required: ['query'],
		type: 'object',
	},
	name: 'search_messages',
	namespace: 'google',
	runtimeValidation: 'local-zod',
	typing: 'structurally-derived',
} as const satisfies GeneratedToolDefinition;

describe('createGeneratedToolFunction', () => {
	it('validates typed input, makes one canonical call, and returns the full result', async () => {
		const { calls, client, close, connect } = createClient();
		const searchMessages = createGeneratedToolFunction<{ readonly query: string }>(
			client,
			localDefinition,
		);
		const abortController = new AbortController();

		const result = await searchMessages(
			{ query: 'newer_than:1d' },
			{
				approvalToken: 'approval-token',
				resultGraceAfterAbortMs: 250,
				signal: abortController.signal,
			},
		);

		expect(result.auditCorrelationId).toBe('audit-1');
		expect(result.items[0]?.status).toBe('ok');
		expect(calls).toHaveBeenCalledTimes(1);
		expect(connect).not.toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();
		expect(calls.mock.calls[0]?.[0]).toMatchObject({
			approvalToken: 'approval-token',
			arguments: {
				calls: [
					{
						arguments: { query: 'newer_than:1d' },
						id: expect.stringMatching(/^generated-/u),
						name: 'search_messages',
						namespace: 'google',
					},
				],
			},
			name: 'tool_portal_call',
		});
		expect(calls.mock.calls[0]?.[1]).toEqual({
			approvalToken: 'approval-token',
			resultGraceAfterAbortMs: 250,
			signal: abortController.signal,
		});
	});

	it('rejects invalid locally supported input before calling Portal', async () => {
		const { calls, client } = createClient();
		const searchMessages = createGeneratedToolFunction<{ readonly query: string }>(
			client,
			localDefinition,
		);

		await expect(searchMessages({ query: '' })).rejects.toThrow();
		expect(calls).not.toHaveBeenCalled();
	});

	it('leaves known unsupported validation to Portal without changing the arguments', async () => {
		const { calls, client } = createClient();
		const definition = {
			...localDefinition,
			diagnostics: [
				{ feature: 'unevaluatedProperties', kind: 'runtime-validation-unsupported', path: [] },
			],
			inputSchema: { type: 'object', unevaluatedProperties: false },
			runtimeValidation: 'portal-only',
		} as const satisfies GeneratedToolDefinition;
		const call = createGeneratedToolFunction<{ readonly arbitrary: string }>(client, definition);

		await call({ arbitrary: 'preserved' });

		expect(calls.mock.calls[0]?.[0]).toMatchObject({
			arguments: { calls: [{ arguments: { arbitrary: 'preserved' } }] },
		});
	});

	it('reports an unexpected lazy Zod conversion failure only when invoked', async () => {
		const { calls, client } = createClient();
		const definition = {
			...localDefinition,
			inputSchema: { type: 'invented-schema-type' },
		} as const satisfies GeneratedToolDefinition;
		const call = createGeneratedToolFunction<Record<string, never>>(client, definition);

		await expect(call({})).rejects.toBeInstanceOf(GeneratedToolSchemaValidationUnavailableError);
		expect(calls).not.toHaveBeenCalled();
	});
});
