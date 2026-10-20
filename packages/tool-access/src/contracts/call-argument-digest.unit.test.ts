import { describe, expect, it } from 'vitest';

import { canonicalCallArguments, hashCallArguments } from './call-argument-digest.js';
// Frozen SHA-256 vectors computed independently with Node crypto over the literal UTF-8 bytes.
describe('legacy call-argument digest bytes', () => {
	it.each([
		{ input: null, bytes: 'null', digest: 'dCNOmK_nSY-12vHzasLXiswzlGT5UHA7jAGYkvmCuQs' },
		{
			input: { b: 2, a: [1, null, { z: true, x: '雪' }] },
			bytes: '{"a":[1,null,{"x":"雪","z":true}],"b":2}',
			digest: 'S0MvAQltEfz2QTqPwzpbYmbNjqt8qa_caDcprJCv0GA',
		},
		{
			input: { z: null, omitted: undefined, a: 1 },
			bytes: '{"a":1,"z":null}',
			digest: '2JiqNv5Z_ht_y8rVlDVIt1uA5lvzSnayCcnq6Aht0NA',
		},
	])('retains canonical bytes $bytes', async ({ input, bytes, digest }) => {
		expect(canonicalCallArguments(input)).toBe(bytes);
		expect(await hashCallArguments(input)).toBe(digest);
	});
	it('ignores object order and allowed omissions, and binds changed arguments', async () => {
		expect(await hashCallArguments({ a: 1, z: null })).toBe(
			'2JiqNv5Z_ht_y8rVlDVIt1uA5lvzSnayCcnq6Aht0NA',
		);
		expect(await hashCallArguments({ a: 2, z: null })).not.toBe(
			'2JiqNv5Z_ht_y8rVlDVIt1uA5lvzSnayCcnq6Aht0NA',
		);
	});
});
