import {
	SandboxEnvironmentCloseResultSchema,
	SandboxEnvironmentOpenResultSchema,
	SandboxEnvironmentStatusResultSchema,
	type SandboxEnvironmentHandle,
} from '@agent-vm/agent-portal-sdk/contracts';
import { describe, expect, it } from 'vitest';

import {
	createGatewayRuntimeSandboxEnvironmentRuntime,
	type GatewayRuntimeSandboxEnvironmentRuntime,
} from './sandbox-environment-runtime.js';

interface RuntimeFixture {
	readonly runtime: GatewayRuntimeSandboxEnvironmentRuntime;
}

function createRuntimeFixture(options?: {
	readonly createHandleId?: () => string;
	readonly maximumEnvironmentCount?: number;
	readonly maximumTerminalTombstones?: number;
	readonly owningGeneration?: string;
}): RuntimeFixture {
	let nextHandle = 0;
	const runtime = createGatewayRuntimeSandboxEnvironmentRuntime({
		createHandleId:
			options?.createHandleId ??
			(() => {
				nextHandle += 1;
				return `environment-${nextHandle}`;
			}),
		maximumEnvironmentCount: options?.maximumEnvironmentCount ?? 4,
		maximumTerminalTombstones: options?.maximumTerminalTombstones ?? 2,
		owningGeneration: options?.owningGeneration ?? 'generation-a',
	});
	return { runtime };
}

describe('Gateway runtime sandbox environment runtime', () => {
	it('represents the selected work root by omission and preserves a strict child cwd', () => {
		// Arrange
		const { runtime } = createRuntimeFixture();

		// Act
		const root = runtime.open({});
		const child = runtime.open({ logicalCwd: 'repo/subdir' });
		const rootStatus = runtime.status({ environment: root.environment });
		const childStatus = runtime.status({ environment: child.environment });

		// Assert
		expect(SandboxEnvironmentOpenResultSchema.parse(root)).toEqual(root);
		expect(SandboxEnvironmentOpenResultSchema.parse(child)).toEqual(child);
		expect(SandboxEnvironmentStatusResultSchema.parse(rootStatus)).toEqual(rootStatus);
		expect(SandboxEnvironmentStatusResultSchema.parse(childStatus)).toEqual(childStatus);
		expect(root).not.toHaveProperty('logicalCwd');
		expect(child.logicalCwd).toBe('repo/subdir');
		expect(rootStatus).not.toHaveProperty('logicalCwd');
		expect(childStatus).toMatchObject({ kind: 'active', logicalCwd: 'repo/subdir' });
		expect(runtime.resolveActiveEnvironment(root.environment)).toEqual({
			environment: root.environment,
			workRelativeCwd: '',
		});
		expect(runtime.resolveActiveEnvironment(child.environment)).toEqual({
			environment: child.environment,
			logicalCwd: 'repo/subdir',
			workRelativeCwd: 'repo/subdir',
		});
		expect(() => runtime.open({ logicalCwd: '../escape' })).toThrow();
	});

	it('rejects forged, wrong-kind, wrong-generation, and cross-instance handles', () => {
		// Arrange
		const first = createRuntimeFixture();
		const wrongGenerationRuntime = createRuntimeFixture({ owningGeneration: 'generation-b' });
		const sameGenerationOtherInstance = createRuntimeFixture();
		const opened = first.runtime.open({});
		const forged = {
			handleId: 'environment-forged',
			kind: 'environment',
			owningGeneration: 'generation-a',
		} as const satisfies SandboxEnvironmentHandle;
		const wrongGeneration = {
			...opened.environment,
			owningGeneration: 'generation-b',
		} satisfies SandboxEnvironmentHandle;
		const wrongKind = {
			...opened.environment,
			kind: 'process',
		} as unknown as SandboxEnvironmentHandle;

		// Act / Assert
		expect(() => first.runtime.status({ environment: forged })).toThrow(/environment handle/i);
		expect(() => first.runtime.close({ environment: wrongGeneration })).toThrow(/generation/i);
		expect(() => first.runtime.resolveActiveEnvironment(wrongKind)).toThrow();
		expect(() =>
			wrongGenerationRuntime.runtime.status({ environment: opened.environment }),
		).toThrow(/generation/i);
		expect(() =>
			sameGenerationOtherInstance.runtime.status({ environment: opened.environment }),
		).toThrow(/environment handle/i);
	});

	it('closes a current environment idempotently and reports truthful status', () => {
		// Arrange
		const { runtime } = createRuntimeFixture();
		const opened = runtime.open({ logicalCwd: 'repo' });

		// Act
		const closed = runtime.close({ environment: opened.environment });
		const alreadyClosed = runtime.close({ environment: opened.environment });
		const status = runtime.status({ environment: opened.environment });

		// Assert
		expect(SandboxEnvironmentCloseResultSchema.parse(closed)).toEqual(closed);
		expect(SandboxEnvironmentCloseResultSchema.parse(alreadyClosed)).toEqual(alreadyClosed);
		expect(SandboxEnvironmentStatusResultSchema.parse(status)).toEqual(status);
		expect(closed.kind).toBe('closed');
		expect(alreadyClosed.kind).toBe('already-closed');
		expect(status.kind).toBe('closed');
		expect(() => runtime.resolveActiveEnvironment(opened.environment)).toThrow(/active/i);
	});

	it('retires synchronously and idempotently with retained replacement truth', () => {
		// Arrange
		const { runtime } = createRuntimeFixture();
		const opened = runtime.open({});

		// Act
		expect(runtime.retire()).toBeUndefined();
		expect(runtime.retire()).toBeUndefined();

		const status = runtime.status({ environment: opened.environment });

		// Assert
		expect(SandboxEnvironmentStatusResultSchema.parse(status)).toEqual(status);
		expect(status.kind).toBe('replaced');
		expect(() => runtime.resolveActiveEnvironment(opened.environment)).toThrow(/retired|active/i);
		expect(() => runtime.open({})).toThrow(/retired/i);
		expect(() => runtime.close({ environment: opened.environment })).toThrow(/replaced/i);
	});

	it('never evicts active authority and deterministically evicts the oldest terminal record', () => {
		// Arrange
		const { runtime } = createRuntimeFixture({
			maximumEnvironmentCount: 2,
			maximumTerminalTombstones: 1,
		});
		const first = runtime.open({});
		const second = runtime.open({ logicalCwd: 'repo' });

		// Act / Assert
		expect(() => runtime.open({})).toThrow(/environment count/i);
		runtime.close({ environment: first.environment });
		const third = runtime.open({ logicalCwd: 'other' });
		expect(() => runtime.status({ environment: first.environment })).toThrow(/environment handle/i);
		expect(runtime.status({ environment: second.environment }).kind).toBe('active');

		runtime.close({ environment: second.environment });
		runtime.close({ environment: third.environment });
		expect(() => runtime.status({ environment: second.environment })).toThrow(
			/environment handle/i,
		);
		expect(runtime.status({ environment: third.environment }).kind).toBe('closed');
	});

	it('prevents repeated factory material from reviving an evicted stale handle', () => {
		// Arrange
		const { runtime } = createRuntimeFixture({
			createHandleId: () => 'repeated-factory-material',
			maximumEnvironmentCount: 1,
			maximumTerminalTombstones: 1,
		});
		const first = runtime.open({});

		// Act
		runtime.close({ environment: first.environment });

		const second = runtime.open({ logicalCwd: 'repo' });

		// Assert
		expect(second.environment.handleId).not.toBe(first.environment.handleId);
		expect(() => runtime.status({ environment: first.environment })).toThrow(/environment handle/i);
		expect(runtime.status({ environment: second.environment }).kind).toBe('active');
		expect(runtime.resolveActiveEnvironment(second.environment).workRelativeCwd).toBe('repo');
	});
});
