import { describe, expect, it } from 'vitest';

import { createOperationFileRetentionBudget } from '../files/operation-file-retention-budget.js';
import { createCredentialedOperationFolders } from './credentialed-operation-folders.js';

function createFolders(): ReturnType<typeof createCredentialedOperationFolders> {
	return createCredentialedOperationFolders(
		createOperationFileRetentionBudget().forOwner({
			agentId: 'sun',
			zoneId: 'zone',
			ownerId: 'vm',
		}),
	);
}

describe('runtime-owned operation-folder accounting', () => {
	it('does not expose a staging folder before known command completion', () => {
		// Arrange
		const folders = createFolders();
		// Act
		const reserved = folders.reserve({
			operationId: 'operation-1',
			directory: '/work/operation-1',
			maximumBytes: 1024,
		});
		// Assert
		expect(reserved).toBe(true);
		expect(folders.lookup('reference-1', 1000)).toBeUndefined();
		expect(folders.retainedBytes()).toBe(1024);
	});

	it('retains complete bytes and fixes expiry to five minutes from completion', () => {
		// Arrange
		const folders = createFolders();
		folders.reserve({
			operationId: 'operation-1',
			directory: '/work/operation-1',
			maximumBytes: 1024,
		});
		// Act
		const reference = folders.complete({
			authorityIsCurrent: () => true,
			operationId: 'operation-1',
			referenceId: 'reference-1',
			byteLength: 100,
			completedAtMs: 1000,
		});
		// Assert
		expect(reference).toEqual({ referenceId: 'reference-1', expiresAtMs: 301000 });
		expect(folders.lookup('reference-1', 300999)?.directory).toBe('/work/operation-1');
		expect(folders.lookup('reference-1', 301000)).toBeUndefined();
		expect(folders.retainedBytes()).toBe(100);
		expect(folders.expired(301000)).toEqual([
			{ operationId: 'operation-1', directory: '/work/operation-1' },
		]);
	});

	it('never silently evicts retained folders to admit new work', () => {
		// Arrange
		const folders = createFolders();
		for (let index = 0; index < 32; index++)
			expect(
				folders.reserve({
					operationId: `operation-${String(index)}`,
					directory: `/work/op-${String(index)}`,
					maximumBytes: 0,
				}),
			).toBe(true);
		// Act / Assert
		expect(
			folders.reserve({ operationId: 'one-too-many', directory: '/work/extra', maximumBytes: 0 }),
		).toBe(false);
	});

	it('accounts for outstanding reservations and unconfirmed cleanup within 64 MiB', () => {
		// Arrange
		const folders = createFolders();
		expect(
			folders.reserve({
				operationId: 'full',
				directory: '/work/full',
				maximumBytes: 64 * 1024 * 1024,
			}),
		).toBe(true);
		// Act / Assert
		expect(
			folders.reserve({ operationId: 'extra', directory: '/work/extra', maximumBytes: 1 }),
		).toBe(false);
		expect(
			folders.complete({
				authorityIsCurrent: () => true,
				operationId: 'full',
				referenceId: 'reference',
				byteLength: 64 * 1024 * 1024 + 1,
				completedAtMs: 1,
			}),
		).toBeUndefined();
		expect(folders.retainedBytes()).toBe(64 * 1024 * 1024);
		folders.removeAfterCleanup('full');
		expect(folders.retainedBytes()).toBe(0);
	});

	it('rejects duplicate operation identity and completion replay', () => {
		// Arrange
		const folders = createFolders();
		folders.reserve({
			operationId: 'operation-1',
			directory: '/work/operation-1',
			maximumBytes: 100,
		});
		// Act / Assert
		expect(
			folders.reserve({
				operationId: 'operation-1',
				directory: '/work/operation-2',
				maximumBytes: 1,
			}),
		).toBe(false);
		expect(
			folders.complete({
				authorityIsCurrent: () => true,
				operationId: 'operation-1',
				referenceId: 'reference',
				byteLength: 10,
				completedAtMs: 1,
			}),
		).toBeDefined();
		expect(
			folders.complete({
				authorityIsCurrent: () => true,
				operationId: 'operation-1',
				referenceId: 'reference-2',
				byteLength: 10,
				completedAtMs: 2,
			}),
		).toBeUndefined();
	});
});
