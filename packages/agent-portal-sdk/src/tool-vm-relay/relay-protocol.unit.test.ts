import { describe, expect, it } from 'vitest';

import { encodeRelayFrame, PortalRelayDecoder } from './relay-protocol.js';

describe('Tool VM Portal relay framing', () => {
	it('finishes a maximum-sized legal frame when the next frame shares the read chunk', () => {
		const first = {
			kind: 'result',
			requestId: 'one',
			result: { padding: Array.from({ length: 16 }, () => 'x'.repeat(65_500)) },
		};
		const second = { kind: 'result', requestId: 'two', result: { padding: 'y'.repeat(20_000) } };
		const firstFrame = encodeRelayFrame(first);
		const decoder = new PortalRelayDecoder();
		expect(decoder.feed(firstFrame.subarray(0, -1))).toEqual([]);
		expect(
			decoder.feed(Buffer.concat([firstFrame.subarray(-1), encodeRelayFrame(second)])),
		).toEqual([first, second]);
	});
	it('rejects duplicate JSON keys including escaped aliases', () => {
		const body = '{"kind":"cancel","requestId":"one","request\\u0049d":"two"}';
		const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
		expect(() => new PortalRelayDecoder().feed(frame)).toThrow();
	});
	it('decodes split and coalesced frames without changing request identities', () => {
		const first = { kind: 'request', requestId: 'one', operation: 'list', request: {} };
		const second = { kind: 'cancel', requestId: 'one' };
		const frames = Buffer.concat([encodeRelayFrame(first), encodeRelayFrame(second)]);
		const decoder = new PortalRelayDecoder();
		expect(decoder.feed(frames.subarray(0, 7))).toEqual([]);
		expect(decoder.feed(frames.subarray(7, -1))).toEqual([first]);
		expect(decoder.feed(frames.subarray(-1))).toEqual([second]);
	});
	it.each(['agentId', 'trustedContext', 'principal', 'approvalDecision'])(
		'rejects guest authority field %s',
		(field) => {
			expect(() =>
				encodeRelayFrame({
					kind: 'request',
					requestId: 'one',
					operation: 'call',
					request: {},
					[field]: 'forged',
				}),
			).toThrow();
		},
	);
	it('rejects oversized declaration before receiving a body', () => {
		expect(() =>
			new PortalRelayDecoder().feed(Buffer.from('Content-Length: 1048577\r\n\r\n')),
		).toThrow();
	});
	it('rejects non-Portal methods', () => {
		expect(() =>
			encodeRelayFrame({
				kind: 'request',
				requestId: 'one',
				operation: 'approval.decide',
				request: {},
			}),
		).toThrow();
	});
});
