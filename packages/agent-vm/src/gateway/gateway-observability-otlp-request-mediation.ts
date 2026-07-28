const gatewayObservabilityOtlpFetchTimeoutMs = 5_000;

type GatewayObservabilityOtlpPath = '/v1/traces' | '/v1/metrics' | '/v1/logs';

interface GatewayObservabilityCollectorHttpRoute {
	readonly host: string;
	readonly httpPort: number;
	readonly targetHost: string;
	readonly targetHttpPort: number;
}

interface RequestInitWithDuplex extends RequestInit {
	readonly duplex?: 'half';
}

export interface CreateGatewayObservabilityOtlpRequestMediationOptions {
	readonly collector: GatewayObservabilityCollectorHttpRoute;
	readonly createDeadlineSignal?: (timeoutMs: number) => AbortSignal;
	readonly fetchImpl?: typeof fetch;
}

function normalizeHostname(hostname: string): string {
	const unbracketedHostname =
		hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
	return unbracketedHostname.toLowerCase();
}

function resolveRequestPort(url: URL): number | undefined {
	if (url.port.length > 0) {
		const parsedPort = Number.parseInt(url.port, 10);
		return Number.isSafeInteger(parsedPort) ? parsedPort : undefined;
	}
	if (url.protocol === 'http:') {
		return 80;
	}
	if (url.protocol === 'https:') {
		return 443;
	}
	return undefined;
}

function isExactAuthority(url: URL, hostname: string, port: number): boolean {
	return (
		normalizeHostname(url.hostname) === normalizeHostname(hostname) &&
		resolveRequestPort(url) === port
	);
}

function assertLoopbackTargetHost(targetHost: string): '127.0.0.1' | '::1' {
	const normalizedTargetHost = normalizeHostname(targetHost);
	if (normalizedTargetHost !== '127.0.0.1' && normalizedTargetHost !== '::1') {
		throw new Error(
			`Gateway observability OTLP targetHost must be loopback 127.0.0.1 or ::1, received '${targetHost}'.`,
		);
	}
	return normalizedTargetHost;
}

function formatTargetAuthority(targetHost: '127.0.0.1' | '::1', targetPort: number): string {
	return targetHost === '::1'
		? `[${targetHost}]:${String(targetPort)}`
		: `${targetHost}:${String(targetPort)}`;
}

function isGatewayObservabilityOtlpPath(
	pathname: string,
): pathname is GatewayObservabilityOtlpPath {
	return pathname === '/v1/traces' || pathname === '/v1/metrics' || pathname === '/v1/logs';
}

function createEmptyResponse(status: number, statusText: string): Response {
	return new Response(null, { status, statusText });
}

function sanitizeUpstreamResponse(upstreamResponse: Response): Response {
	const headers = new Headers();
	const contentType = upstreamResponse.headers.get('content-type');
	if (contentType !== null) {
		headers.set('content-type', contentType);
	}
	const retryAfter = upstreamResponse.headers.get('retry-after');
	if (retryAfter !== null) {
		headers.set('retry-after', retryAfter);
	}
	return new Response(upstreamResponse.body, {
		headers,
		status: upstreamResponse.status,
		statusText: upstreamResponse.statusText,
	});
}

async function cancelResponseBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// The local error response remains authoritative if upstream cleanup fails.
	}
}

export function createGatewayObservabilityOtlpRequestMediation(
	options: CreateGatewayObservabilityOtlpRequestMediationOptions,
): (request: Request) => Promise<Response | undefined> {
	const targetHost = assertLoopbackTargetHost(options.collector.targetHost);
	const targetAuthority = formatTargetAuthority(targetHost, options.collector.targetHttpPort);
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const createDeadlineSignal =
		options.createDeadlineSignal ??
		((timeoutMs: number): AbortSignal => AbortSignal.timeout(timeoutMs));

	return async (request: Request): Promise<Response | undefined> => {
		const requestUrl = new URL(request.url);

		if (isExactAuthority(requestUrl, targetHost, options.collector.targetHttpPort)) {
			return createEmptyResponse(403, 'Forbidden');
		}

		if (!isExactAuthority(requestUrl, options.collector.host, options.collector.httpPort)) {
			return undefined;
		}

		if (requestUrl.protocol !== 'http:') {
			return createEmptyResponse(400, 'Bad Request');
		}
		if (
			requestUrl.username.length > 0 ||
			requestUrl.password.length > 0 ||
			requestUrl.search.length > 0 ||
			requestUrl.hash.length > 0
		) {
			return createEmptyResponse(400, 'Bad Request');
		}
		if (request.method !== 'POST') {
			return createEmptyResponse(405, 'Method Not Allowed');
		}
		if (!isGatewayObservabilityOtlpPath(requestUrl.pathname)) {
			return createEmptyResponse(404, 'Not Found');
		}
		if (request.headers.get('content-type') !== 'application/x-protobuf') {
			return createEmptyResponse(415, 'Unsupported Media Type');
		}
		if (request.headers.has('content-encoding')) {
			return createEmptyResponse(415, 'Unsupported Media Type');
		}

		const targetUrl = `http://${targetAuthority}${requestUrl.pathname}`;
		const deadlineSignal = createDeadlineSignal(gatewayObservabilityOtlpFetchTimeoutMs);
		const requestInit: RequestInitWithDuplex = {
			headers: new Headers({ 'content-type': 'application/x-protobuf' }),
			method: 'POST',
			redirect: 'manual',
			signal: deadlineSignal,
			...(request.body === null ? {} : { body: request.body, duplex: 'half' }),
		};

		let upstreamResponse: Response;
		try {
			upstreamResponse = await fetchImpl(targetUrl, requestInit);
		} catch {
			return deadlineSignal.aborted
				? createEmptyResponse(504, 'Gateway Timeout')
				: createEmptyResponse(502, 'Bad Gateway');
		}

		if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
			await cancelResponseBody(upstreamResponse);
			return createEmptyResponse(502, 'Bad Gateway');
		}

		return sanitizeUpstreamResponse(upstreamResponse);
	};
}
