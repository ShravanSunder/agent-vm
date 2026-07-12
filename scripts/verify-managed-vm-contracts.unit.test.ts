import { describe, expect, it } from 'vitest';

import {
	auditManagedVmPublicDeclarations,
	verifyManagedVmContracts,
} from './verify-managed-vm-contracts.js';

describe('managed-vm compile contracts', () => {
	it('accepts the neutral fake provider and rejects forbidden consumer access', () => {
		const verification = verifyManagedVmContracts();

		expect(verification.positiveDiagnostics).toEqual([]);
		expect(verification.negativeFixtures).toEqual([
			{
				fixtureName: 'aggregate-provider-consumer',
				matchedExpectedDiagnostic: true,
			},
			{
				fixtureName: 'closed-contract-variants',
				matchedExpectedDiagnostic: true,
			},
			{
				fixtureName: 'native-escape-hatches',
				matchedExpectedDiagnostic: true,
			},
		]);
	});
});

describe('managed-vm public declaration neutrality', () => {
	it('accepts structural managed VM declarations and adapter-owned native declarations', () => {
		expect(
			auditManagedVmPublicDeclarations([
				{
					content: "import type { ManagedVm } from '@agent-vm/managed-vm';",
					filePath: 'packages/agent-vm/dist/index.d.ts',
					packageName: '@agent-vm/agent-vm',
				},
				{
					content: "import type { VirtualProvider } from '@earendil-works/gondolin';",
					filePath: 'packages/gondolin-vm-adapter/dist/index.d.ts',
					packageName: '@agent-vm/gondolin-vm-adapter',
				},
			]),
		).toEqual([]);
	});

	it.each([
		[
			"import type { VirtualProvider } from '@earendil-works/gondolin';",
			'@earendil-works/gondolin',
		],
		['export interface PublicVm { getVmInstance(): ManagedVmInstance; }', 'ManagedVmInstance'],
		['export interface PublicVm { getVmInstance(): object; }', 'getVmInstance'],
		['export interface Request { nativeOptions?: object; }', 'nativeOptions'],
		['export interface Request { backendData?: unknown; }', 'backendData'],
		['export interface Root { pinned: PinnedRealFsRoot; }', 'PinnedRealFsRoot'],
	] as const)('rejects public native escape token %s', (content, forbiddenToken) => {
		const findings = auditManagedVmPublicDeclarations([
			{
				content,
				filePath: 'packages/managed-vm/dist/index.d.ts',
				packageName: '@agent-vm/managed-vm',
			},
		]);

		expect(findings).toContainEqual({
			filePath: 'packages/managed-vm/dist/index.d.ts',
			forbiddenToken,
			packageName: '@agent-vm/managed-vm',
		});
	});
});
