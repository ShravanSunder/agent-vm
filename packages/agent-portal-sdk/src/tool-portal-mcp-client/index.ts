import {
	createPortalArtifactReadResourceRequest,
	PortalArtifactReadRequestSchema,
	PortalArtifactReadResultSchema,
	type PortalArtifactReadRequest,
	type PortalArtifactReadResourceRequest,
	type PortalArtifactReadResult,
} from '../artifact-surface/index.js';
import {
	PortalCallRequestSchema,
	PortalCallResultSchema,
	PortalDescribeRequestSchema,
	PortalDescribeResultSchema,
	PortalListRequestSchema,
	PortalListResultSchema,
	PortalSearchRequestSchema,
	PortalSearchResultSchema,
	type PortalCallRequest,
	type PortalCallResult,
	type PortalDescribeRequest,
	type PortalDescribeResult,
	type PortalListRequest,
	type PortalListResult,
	type PortalSearchRequest,
	type PortalSearchResult,
} from '../portal-call-surface/index.js';

export type ToolPortalMcpResourceContent =
	| {
			readonly blob: string;
			readonly kind: 'blob';
			readonly mediaType?: string;
			readonly uri: string;
	  }
	| {
			readonly kind: 'text';
			readonly mediaType?: string;
			readonly text: string;
			readonly uri: string;
	  };

export interface ToolPortalMcpTransport {
	readonly callTool: (
		call: {
			readonly approvalToken?: string;
			readonly arguments: unknown;
			readonly name: string;
		},
		options?: {
			readonly resultGraceAfterAbortMs?: number;
			readonly signal?: AbortSignal;
		},
	) => Promise<{ readonly structuredContent?: unknown }>;
	readonly close: () => Promise<void>;
	readonly connect: () => Promise<void>;
	readonly readResource: (
		request: PortalArtifactReadResourceRequest,
		options?: {
			readonly resultGraceAfterAbortMs?: number;
			readonly signal?: AbortSignal;
		},
	) => Promise<{ readonly contents: readonly ToolPortalMcpResourceContent[] }>;
}

export interface ToolPortalMcpClientOptions {
	readonly transport: ToolPortalMcpTransport;
}

export interface ToolPortalClientRequestOptions {
	readonly approvalToken?: string;
	readonly resultGraceAfterAbortMs?: number;
	readonly signal?: AbortSignal;
}

const canonicalBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function decodedBase64ByteLength(contentBase64: string): number {
	if (!canonicalBase64Pattern.test(contentBase64)) {
		throw new TypeError('Tool Portal MCP artifact content is not canonical base64.');
	}
	const paddingBytes = contentBase64.endsWith('==') ? 2 : contentBase64.endsWith('=') ? 1 : 0;
	return (contentBase64.length / 4) * 3 - paddingBytes;
}

class ToolPortalMcpArtifactOperations {
	readonly #transport: ToolPortalMcpTransport;

	constructor(transport: ToolPortalMcpTransport) {
		this.#transport = transport;
	}

	async read(
		request: PortalArtifactReadRequest,
		options: ToolPortalClientRequestOptions = {},
	): Promise<PortalArtifactReadResult> {
		const validatedRequest = PortalArtifactReadRequestSchema.parse(request);
		const resourceRequest = createPortalArtifactReadResourceRequest(validatedRequest);
		const response = await this.#transport.readResource(resourceRequest, options);
		const content = response.contents.length === 1 ? response.contents[0] : undefined;
		if (
			content === undefined ||
			content.kind !== 'blob' ||
			content.uri !== resourceRequest.uri ||
			content.mediaType === undefined
		) {
			throw new TypeError('Tool Portal MCP artifact read returned an invalid resource.');
		}
		const returnedBytes = decodedBase64ByteLength(content.blob);
		if (returnedBytes > validatedRequest.maxBytes) {
			throw new TypeError('Tool Portal MCP artifact read exceeded the requested byte range.');
		}
		return PortalArtifactReadResultSchema.parse({
			contentBase64: content.blob,
			mediaType: content.mediaType,
			offsetBytes: validatedRequest.offsetBytes,
			reference: validatedRequest.reference,
			truncated:
				validatedRequest.offsetBytes + returnedBytes < validatedRequest.reference.byteLength,
		});
	}
}

/**
 * Standard-MCP projection of the bounded Tool Portal surface.
 *
 * The transport is injected so this subpath remains independent from the
 * Gateway-runtime UDS client and its Node-specific dependencies.
 */
export class ToolPortalMcpClient {
	readonly #transport: ToolPortalMcpTransport;
	readonly artifacts: ToolPortalMcpArtifactOperations;

	constructor(options: ToolPortalMcpClientOptions) {
		this.#transport = options.transport;
		this.artifacts = new ToolPortalMcpArtifactOperations(this.#transport);
	}

	async connect(): Promise<void> {
		await this.#transport.connect();
	}

	async close(): Promise<void> {
		await this.#transport.close();
	}

	async list(
		request: PortalListRequest,
		options: ToolPortalClientRequestOptions = {},
	): Promise<PortalListResult> {
		const validatedRequest = PortalListRequestSchema.parse(request);
		const response = await this.#transport.callTool(
			{
				arguments: validatedRequest,
				name: 'tool_portal_list',
			},
			options,
		);
		return PortalListResultSchema.parse(response.structuredContent);
	}

	async search(
		request: PortalSearchRequest,
		options: ToolPortalClientRequestOptions = {},
	): Promise<PortalSearchResult> {
		const validatedRequest = PortalSearchRequestSchema.parse(request);
		const response = await this.#transport.callTool(
			{
				arguments: validatedRequest,
				name: 'tool_portal_search',
			},
			options,
		);
		return PortalSearchResultSchema.parse(response.structuredContent);
	}

	async describe(
		request: PortalDescribeRequest,
		options: ToolPortalClientRequestOptions = {},
	): Promise<PortalDescribeResult> {
		const validatedRequest = PortalDescribeRequestSchema.parse(request);
		const response = await this.#transport.callTool(
			{
				arguments: validatedRequest,
				name: 'tool_portal_describe',
			},
			options,
		);
		return PortalDescribeResultSchema.parse(response.structuredContent);
	}

	async call(
		request: PortalCallRequest,
		options: ToolPortalClientRequestOptions = {},
	): Promise<PortalCallResult> {
		const validatedRequest = PortalCallRequestSchema.parse(request);
		const response = await this.#transport.callTool(
			{
				...(options.approvalToken === undefined ? {} : { approvalToken: options.approvalToken }),
				arguments: validatedRequest,
				name: 'tool_portal_call',
			},
			options,
		);
		return PortalCallResultSchema.parse(response.structuredContent);
	}
}
