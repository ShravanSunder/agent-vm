import { describe, expect, expectTypeOf, it } from 'vitest';

import {
	DEFAULT_GATEWAY_RUNTIME_SANDBOX_TRAVERSAL_LIMITS,
	createGatewayRuntimeSandboxPathContract,
	type GatewayRuntimeSandboxTraversalLimits,
	type GatewayRuntimeSandboxTraversalObservation,
} from './sandbox-path-contract.js';

const withinTraversalLimits = {
	bytesRead: 1_024,
	depth: 3,
	elapsedMs: 25,
	entriesVisited: 8,
	symlinkDepth: 1,
} as const satisfies GatewayRuntimeSandboxTraversalObservation;

describe('Gateway runtime sandbox path contract', () => {
	it('requires grouped traversal limits at every composition boundary', () => {
		type PathContractOptions = Parameters<typeof createGatewayRuntimeSandboxPathContract>[0];

		expectTypeOf<PathContractOptions>().toEqualTypeOf<{
			readonly guestWorkRoot: '/work';
			readonly limits: GatewayRuntimeSandboxTraversalLimits;
		}>();
	});

	it.each([
		['absolute path', '/etc/passwd', 'path-must-be-work-relative'],
		['NUL byte', 'src\u0000/secret', 'path-contains-nul'],
		['parent traversal', 'src/../secret', 'path-traverses-parent'],
	] as const)('rejects %s', (_label, requestedPath, reason) => {
		const contract = createGatewayRuntimeSandboxPathContract({
			guestWorkRoot: '/work',
			limits: DEFAULT_GATEWAY_RUNTIME_SANDBOX_TRAVERSAL_LIMITS,
		});

		expect(contract.resolve(requestedPath)).toEqual({ kind: 'rejected', reason });
	});

	it('normalizes an accepted relative path only beneath the fixed Tool VM /work root', () => {
		const contract = createGatewayRuntimeSandboxPathContract({
			guestWorkRoot: '/work',
			limits: DEFAULT_GATEWAY_RUNTIME_SANDBOX_TRAVERSAL_LIMITS,
		});

		expect(contract.resolve('src//components/./button.ts')).toEqual({
			guestPath: '/work/src/components/button.ts',
			kind: 'resolved',
			relativePath: 'src/components/button.ts',
		});
	});

	it('does not expose a host-path translation or a ManagedVm/Gondolin filesystem value', () => {
		const contract = createGatewayRuntimeSandboxPathContract({
			guestWorkRoot: '/work',
			limits: DEFAULT_GATEWAY_RUNTIME_SANDBOX_TRAVERSAL_LIMITS,
		});
		const resolution = contract.resolve('src/index.ts');

		expect(resolution).toEqual({
			guestPath: '/work/src/index.ts',
			kind: 'resolved',
			relativePath: 'src/index.ts',
		});
		expect(Object.keys(resolution)).not.toContain('hostPath');
		expect(Object.keys(resolution)).not.toContain('filesystem');
	});

	it.each([
		['entries', { entriesVisited: 101 }, 'entry-cap-exceeded'],
		['depth', { depth: 17 }, 'depth-cap-exceeded'],
		['bytes', { bytesRead: 1_048_577 }, 'byte-cap-exceeded'],
		['time', { elapsedMs: 5_001 }, 'time-cap-exceeded'],
		['symlink traversal', { symlinkDepth: 9 }, 'symlink-cap-exceeded'],
	] as const)('fails closed when the %s bound is exceeded', (_label, changedField, reason) => {
		const contract = createGatewayRuntimeSandboxPathContract({
			guestWorkRoot: '/work',
			limits: {
				maxBytes: 1_048_576,
				maxDepth: 16,
				maxElapsedMs: 5_000,
				maxEntries: 100,
				maxSymlinkDepth: 8,
			},
		});

		expect(contract.authorizeTraversal({ ...withinTraversalLimits, ...changedField })).toEqual({
			kind: 'rejected',
			reason,
		});
	});
});
