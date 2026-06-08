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

	it('returns only allocated mappings in sorted slot order', () => {
		const tcpPool = createTcpPool({
			basePort: 19000,
			size: 3,
		});

		expect(tcpPool.allocate()).toBe(0);
		expect(tcpPool.allocate()).toBe(1);
		tcpPool.release(0);
		expect(tcpPool.allocate()).toBe(0);

		expect(tcpPool.getAllMappings()).toEqual({
			'tool-0.vm.host:22': '127.0.0.1:19000',
			'tool-1.vm.host:22': '127.0.0.1:19001',
		});
	});

	it('throws when all slots are exhausted until one is released', () => {
		const tcpPool = createTcpPool({
			basePort: 20000,
			size: 1,
		});

		expect(tcpPool.allocate()).toBe(0);
		expect(() => tcpPool.allocate()).toThrow('No TCP slots available');

		tcpPool.release(0);
		expect(tcpPool.allocate()).toBe(0);
		expect(tcpPool.portForSlot(0)).toBe(20000);
	});
});
