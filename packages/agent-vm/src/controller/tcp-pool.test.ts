import { describe, expect, it } from 'vitest';

import { createTcpPool } from './tcp-pool.js';

describe('createTcpPool', () => {
	it('allocates sequential slots and reuses released slots', () => {
		const tcpPool = createTcpPool({
			basePort: 19000,
			size: 2,
		});

		expect(tcpPool.allocate()).toBe(0);
		expect(tcpPool.allocate()).toBe(1);
		expect(() => tcpPool.allocate()).toThrow(/No TCP slots available/u);
		expect(tcpPool.portForSlot(1)).toBe(19001);

		tcpPool.release(0);
		expect(tcpPool.allocate()).toBe(0);
	});
});
