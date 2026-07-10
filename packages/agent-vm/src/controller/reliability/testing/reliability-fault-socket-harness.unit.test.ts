import { describe, expect, it } from 'vitest';

import {
	RELIABILITY_FAULT_RUNTIME_DIRECTORY_MODE,
	RELIABILITY_FAULT_SOCKET_MODE,
	resolveReliabilityFaultSocketPaths,
} from './reliability-fault-socket-harness.js';

describe('resolveReliabilityFaultSocketPaths', () => {
	it('keeps a bounded socket under the owned runtime directory with locked modes', () => {
		const paths = resolveReliabilityFaultSocketPaths('/owned/runtime', 'run-a');
		expect(paths).toMatchObject({
			runtimeDirectoryMode: 0o700,
			socketMode: 0o600,
		});
		expect(paths.runtimeDirectoryPath).toMatch(/^\/owned\/runtime\/r-[a-f0-9]{12}$/u);
		expect(paths.socketPath).toBe(`${paths.runtimeDirectoryPath}/f.sock`);
		expect(RELIABILITY_FAULT_RUNTIME_DIRECTORY_MODE).toBe(0o700);
		expect(RELIABILITY_FAULT_SOCKET_MODE).toBe(0o600);
	});

	it('rejects traversal and unbounded run identifiers', () => {
		expect(() => resolveReliabilityFaultSocketPaths('/owned/runtime', '../escape')).toThrow();
		expect(() => resolveReliabilityFaultSocketPaths('/owned/runtime', 'x'.repeat(129))).toThrow();
	});
});
