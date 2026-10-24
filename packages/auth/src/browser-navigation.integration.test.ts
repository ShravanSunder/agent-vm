import { createServer } from 'node:http';

import { expect, it } from 'vitest';

import { navigateLocalBrowser } from '#auth/test-fixtures/browser-navigation';

it('preserves top-level navigation headers, cookies and response bytes without following the next hop', async () => {
	const received: {
		readonly path: string;
		readonly mode: string | undefined;
		readonly accept: string | undefined;
		readonly cookie: string | undefined;
	}[] = [];
	const server = createServer((request, response) => {
		received.push({
			path: request.url ?? '',
			mode: request.headers['sec-fetch-mode']?.toString(),
			accept: request.headers.accept,
			cookie: request.headers.cookie,
		});
		response.writeHead(302, {
			location: '/next-hop',
			'set-cookie': ['first=synthetic; HttpOnly', 'second=synthetic; HttpOnly'],
		});
		response.write('navigation ');
		response.end('response');
	});
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once('error', rejectListen);
		server.listen(0, '127.0.0.1', resolveListen);
	});
	try {
		const address = server.address();
		if (address === null || typeof address === 'string')
			throw new Error('Missing navigation fixture listener');
		const response = await navigateLocalBrowser(`http://127.0.0.1:${address.port}/first-hop`, {
			cookie: 'fixture=synthetic',
		});
		expect(received).toEqual([
			{ path: '/first-hop', mode: 'navigate', accept: 'text/html', cookie: 'fixture=synthetic' },
		]);
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe('/next-hop');
		expect(response.headers.getSetCookie()).toEqual([
			'first=synthetic; HttpOnly',
			'second=synthetic; HttpOnly',
		]);
		expect(await response.text()).toBe('navigation response');
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	}
});

it('connects to the loopback Worker listener while preserving the logical issuer Host and request path', async () => {
	const server = createServer((request, response) => {
		response.writeHead(200, { 'content-type': 'application/json' }).end(
			JSON.stringify({
				host: request.headers.host,
				path: request.url,
				mode: request.headers['sec-fetch-mode'],
			}),
		);
	});
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once('error', rejectListen);
		server.listen(0, '127.0.0.1', resolveListen);
	});
	try {
		const address = server.address();
		if (address === null || typeof address === 'string')
			throw new Error('Missing bridge fixture listener');
		const response = await navigateLocalBrowser(
			'http://logical-issuer.invalid/authorize?state=synthetic',
			{},
			new URL(`http://127.0.0.1:${address.port}`),
		);
		expect(await response.json()).toEqual({
			host: 'logical-issuer.invalid',
			path: '/authorize?state=synthetic',
			mode: 'navigate',
		});
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	}
});
