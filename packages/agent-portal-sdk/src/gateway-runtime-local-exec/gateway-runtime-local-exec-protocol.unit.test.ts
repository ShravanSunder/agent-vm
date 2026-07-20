import { describe, expect, it } from 'vitest';

import {
	GatewayRuntimeLocalExecLineDecoder,
	GatewayRuntimeLocalExecProtocolError,
	encodeGatewayRuntimeLocalExecFrame,
	parseGatewayRuntimeLocalExecClientFrame,
	parseGatewayRuntimeLocalExecServerFrame,
} from './gateway-runtime-local-exec-protocol.js';

describe('Gateway Runtime local exec protocol', () => {
	it('round-trips the narrow client and server frame unions', () => {
		const clientLine = encodeGatewayRuntimeLocalExecFrame({
			contentBase64: Buffer.from('input').toString('base64'),
			kind: 'stdin-chunk',
		}).trimEnd();
		const serverLine = encodeGatewayRuntimeLocalExecFrame({
			exitCode: 17,
			kind: 'exited',
		}).trimEnd();

		expect(parseGatewayRuntimeLocalExecClientFrame(clientLine)).toEqual({
			contentBase64: 'aW5wdXQ=',
			kind: 'stdin-chunk',
		});
		expect(parseGatewayRuntimeLocalExecServerFrame(serverLine)).toEqual({
			exitCode: 17,
			kind: 'exited',
		});
	});

	it('rejects authority-shaped or unknown fields', () => {
		expect(() =>
			parseGatewayRuntimeLocalExecClientFrame(
				JSON.stringify({ kind: 'authenticate', principal: 'agent-a', token: 'opaque' }),
			),
		).toThrow(GatewayRuntimeLocalExecProtocolError);
		expect(() =>
			parseGatewayRuntimeLocalExecClientFrame(
				JSON.stringify({ command: 'id', kind: 'execute', token: 'opaque' }),
			),
		).toThrow(GatewayRuntimeLocalExecProtocolError);
	});

	it('rejects malformed and oversized stream chunks', () => {
		expect(() =>
			parseGatewayRuntimeLocalExecClientFrame(
				JSON.stringify({ contentBase64: 'not-base64!', kind: 'stdin-chunk' }),
			),
		).toThrow(GatewayRuntimeLocalExecProtocolError);
		expect(() =>
			parseGatewayRuntimeLocalExecServerFrame(
				JSON.stringify({
					contentBase64: Buffer.alloc(64 * 1024 + 1).toString('base64'),
					kind: 'stdout-chunk',
				}),
			),
		).toThrow(GatewayRuntimeLocalExecProtocolError);
	});

	it('decodes fragmented and coalesced lines while enforcing a frame bound', () => {
		const decoder = new GatewayRuntimeLocalExecLineDecoder();
		expect(decoder.push(Buffer.from('{"kind":"cancel"'))).toEqual([]);
		expect(decoder.push(Buffer.from('}\n{"kind":"stdin-end"}\n'))).toEqual([
			'{"kind":"cancel"}',
			'{"kind":"stdin-end"}',
		]);

		expect(() => decoder.push(Buffer.alloc(128 * 1024 + 1, 0x61))).toThrow(
			GatewayRuntimeLocalExecProtocolError,
		);
	});
});
