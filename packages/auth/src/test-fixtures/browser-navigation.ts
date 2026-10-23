import { request as httpRequest } from 'node:http';

/** Test-only browser navigation: preserve navigation metadata and observe each redirect hop explicitly. */
export async function navigateLocalBrowser(
	url: string | URL,
	headers: HeadersInit = {},
	connectionOrigin?: URL,
): Promise<Response> {
	return new Promise<Response>((resolveResponse, rejectResponse) => {
		const request = httpRequest(
			url,
			{
				method: 'GET',
				...(connectionOrigin === undefined
					? {}
					: { hostname: connectionOrigin.hostname, port: connectionOrigin.port }),
				headers: Object.fromEntries(
					new Headers({
						...Object.fromEntries(new Headers(headers)),
						host: new URL(url).host,
						'sec-fetch-mode': 'navigate',
						accept: 'text/html',
					}),
				),
				signal: AbortSignal.timeout(30_000),
			},
			(incoming) => {
				void (async (): Promise<Response> => {
					const chunks: Uint8Array[] = [];
					for await (const chunk of incoming) {
						if (!Buffer.isBuffer(chunk)) throw new Error('Unexpected browser navigation body');
						chunks.push(chunk);
					}
					const responseHeaders = new Headers();
					for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
						const name = incoming.rawHeaders[index];
						const value = incoming.rawHeaders[index + 1];
						if (name !== undefined && value !== undefined) responseHeaders.append(name, value);
					}
					if (incoming.statusCode === undefined)
						throw new Error('Navigation response lacks status');
					const body = Uint8Array.from(Buffer.concat(chunks));
					return new Response(body.length === 0 ? null : body, {
						status: incoming.statusCode,
						headers: responseHeaders,
					});
				})().then(resolveResponse, rejectResponse);
			},
		);
		request.once('error', rejectResponse);
		request.end();
	});
}
