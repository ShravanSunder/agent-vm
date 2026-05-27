import { describe, expect, it } from 'vitest';

import { composeNodeOptions, FORCE_IPV4_EGRESS_NODE_OPTIONS } from './force-ipv4-egress.js';

describe('FORCE_IPV4_EGRESS_NODE_OPTIONS', () => {
	it('contains both flags needed to defeat undici Happy Eyeballs', () => {
		expect(FORCE_IPV4_EGRESS_NODE_OPTIONS).toContain('--dns-result-order=ipv4first');
		expect(FORCE_IPV4_EGRESS_NODE_OPTIONS).toContain('--no-network-family-autoselection');
	});
});

describe('composeNodeOptions', () => {
	it('returns just the forced flags when user value is undefined', () => {
		expect(composeNodeOptions(undefined)).toBe(FORCE_IPV4_EGRESS_NODE_OPTIONS);
	});

	it('returns just the forced flags when user value is empty', () => {
		expect(composeNodeOptions('')).toBe(FORCE_IPV4_EGRESS_NODE_OPTIONS);
	});

	it('returns just the forced flags when user value is whitespace-only', () => {
		expect(composeNodeOptions('   ')).toBe(FORCE_IPV4_EGRESS_NODE_OPTIONS);
		expect(composeNodeOptions('\t\n')).toBe(FORCE_IPV4_EGRESS_NODE_OPTIONS);
	});

	it('appends a non-empty user value after the forced flags', () => {
		expect(composeNodeOptions('--inspect=0.0.0.0:9229')).toBe(
			`${FORCE_IPV4_EGRESS_NODE_OPTIONS} --inspect=0.0.0.0:9229`,
		);
	});

	it('trims user value before appending so leading whitespace does not duplicate spaces', () => {
		expect(composeNodeOptions('   --inspect')).toBe(`${FORCE_IPV4_EGRESS_NODE_OPTIONS} --inspect`);
		expect(composeNodeOptions('--inspect   ')).toBe(`${FORCE_IPV4_EGRESS_NODE_OPTIONS} --inspect`);
	});

	it('preserves multi-flag user values verbatim', () => {
		expect(composeNodeOptions('--inspect --max-old-space-size=4096')).toBe(
			`${FORCE_IPV4_EGRESS_NODE_OPTIONS} --inspect --max-old-space-size=4096`,
		);
	});

	it('deduplicates forced flags from a user value', () => {
		expect(composeNodeOptions(FORCE_IPV4_EGRESS_NODE_OPTIONS)).toBe(FORCE_IPV4_EGRESS_NODE_OPTIONS);
		expect(composeNodeOptions(`--inspect ${FORCE_IPV4_EGRESS_NODE_OPTIONS}`)).toBe(
			`${FORCE_IPV4_EGRESS_NODE_OPTIONS} --inspect`,
		);
	});

	it('places forced flags FIRST in the composed string', () => {
		// Forced flags lead so they apply regardless of how Node
		// interprets duplicate / conflicting flags in NODE_OPTIONS.
		const composed = composeNodeOptions('--inspect');
		expect(composed.startsWith(FORCE_IPV4_EGRESS_NODE_OPTIONS)).toBe(true);
	});
});
