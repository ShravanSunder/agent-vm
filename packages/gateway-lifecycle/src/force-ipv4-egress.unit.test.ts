import { describe, expect, it } from 'vitest';

import { FORCE_IPV4_EGRESS_NODE_OPTIONS } from './force-ipv4-egress.js';
import * as gatewayLifecyclePublicExports from './index.js';

describe('FORCE_IPV4_EGRESS_NODE_OPTIONS', () => {
	it('contains both flags needed to defeat undici Happy Eyeballs', () => {
		expect(FORCE_IPV4_EGRESS_NODE_OPTIONS).toContain('--dns-result-order=ipv4first');
		expect(FORCE_IPV4_EGRESS_NODE_OPTIONS).toContain('--no-network-family-autoselection');
	});
});

it('does not expose the retired Worker option-composition API', () => {
	expect(gatewayLifecyclePublicExports).not.toHaveProperty('composeNodeOptions');
});
