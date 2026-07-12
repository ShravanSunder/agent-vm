import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	expectedControlLeaseReliabilityEvidenceWriteKind,
	hashControlLeaseReliabilityArtifact,
	type ControlLeaseReliabilityEvidencePayload,
	writeControlLeaseReliabilityEvidence,
} from './control-lease-reliability-evidence.js';

const temporaryDirectories: string[] = [];
const operationId = 'openclaw-process-recovery';

async function createEvidenceFilePath(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), 'agent-vm-reliability-evidence-'));
	temporaryDirectories.push(directory);
	return path.join(directory, `${operationId}.json`);
}

function evidenceEnvironment(evidenceFilePath: string): NodeJS.ProcessEnv {
	return {
		AGENT_VM_RELIABILITY_DIRTY_HASH: 'b'.repeat(64),
		AGENT_VM_RELIABILITY_EVIDENCE_FILE: evidenceFilePath,
		AGENT_VM_RELIABILITY_HEAD_SHA: 'a'.repeat(40),
		AGENT_VM_RELIABILITY_OPERATION_ID: operationId,
		AGENT_VM_RELIABILITY_RUN_ID: 'run-process-recovery-1',
	};
}

function evidencePayload(): ControlLeaseReliabilityEvidencePayload {
	return {
		artifacts: [
			{
				operationId: 'process-recovery-transition',
				sha256: hashControlLeaseReliabilityArtifact('observed-transition'),
			},
		],
		generationIdentities: [{ generation: 1, targetId: 'gateway-epoch-1', targetKind: 'gateway' }],
		packageIdentities: [
			{
				checksumSha256: 'c'.repeat(64),
				name: '@agent-vm/agent-vm',
				version: '0.0.113',
			},
		],
		processIdentities: [
			{
				bootId: 'process-epoch-1',
				kind: 'openclaw-process',
				processId: 123,
				startIdentity: 'proc-start-456',
			},
		],
		runtimeIdentities: [{ generation: 1, id: 'tool-lease-1', kind: 'tool-vm-lease' }],
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (directory) => {
			await rm(directory, { force: true, recursive: true });
		}),
	);
});

describe('writeControlLeaseReliabilityEvidence', () => {
	it('distinguishes generic proof lanes from a configured canonical evidence run', () => {
		expect(expectedControlLeaseReliabilityEvidenceWriteKind({})).toBe('not-configured');
		expect(
			expectedControlLeaseReliabilityEvidenceWriteKind({
				AGENT_VM_RELIABILITY_EVIDENCE_FILE: '/owned/evidence.json',
			}),
		).toBe('written');
	});

	it('writes schema-valid evidence bound to the exact runner environment', async () => {
		// Arrange
		const evidenceFilePath = await createEvidenceFilePath();

		// Act
		const result = await writeControlLeaseReliabilityEvidence({
			environment: evidenceEnvironment(evidenceFilePath),
			expectedOperationId: operationId,
			payload: evidencePayload(),
		});

		// Assert
		expect(result).toEqual({ kind: 'written', path: evidenceFilePath });
		const serializedEvidence = JSON.parse(await readFile(evidenceFilePath, 'utf8')) as unknown;
		expect(serializedEvidence).toEqual({
			...evidencePayload(),
			dirtyHash: 'b'.repeat(64),
			headSha: 'a'.repeat(40),
			operationId,
			runId: 'run-process-recovery-1',
			schemaVersion: 1,
		});
	});

	it('is a no-op only when every reliability runner binding is absent', async () => {
		await expect(
			writeControlLeaseReliabilityEvidence({
				environment: {},
				expectedOperationId: operationId,
				payload: evidencePayload(),
			}),
		).resolves.toEqual({ kind: 'not-configured' });

		await expect(
			writeControlLeaseReliabilityEvidence({
				environment: { AGENT_VM_RELIABILITY_OPERATION_ID: operationId },
				expectedOperationId: operationId,
				payload: evidencePayload(),
			}),
		).rejects.toThrow(/bindings are incomplete/u);
	});

	it('rejects mismatched operation, unsafe path, invalid identities, and overwrite', async () => {
		const evidenceFilePath = await createEvidenceFilePath();
		const environment = evidenceEnvironment(evidenceFilePath);

		await expect(
			writeControlLeaseReliabilityEvidence({
				environment: { ...environment, AGENT_VM_RELIABILITY_OPERATION_ID: 'wrong-operation' },
				expectedOperationId: operationId,
				payload: evidencePayload(),
			}),
		).rejects.toThrow(/operation.*mismatch/iu);
		await expect(
			writeControlLeaseReliabilityEvidence({
				environment: {
					...environment,
					AGENT_VM_RELIABILITY_EVIDENCE_FILE: path.join(
						path.dirname(evidenceFilePath),
						'other.json',
					),
				},
				expectedOperationId: operationId,
				payload: evidencePayload(),
			}),
		).rejects.toThrow(/evidence path/iu);
		await expect(
			writeControlLeaseReliabilityEvidence({
				environment,
				expectedOperationId: operationId,
				payload: { ...evidencePayload(), processIdentities: [] },
			}),
		).rejects.toThrow();

		await writeControlLeaseReliabilityEvidence({
			environment,
			expectedOperationId: operationId,
			payload: evidencePayload(),
		});
		await expect(
			writeControlLeaseReliabilityEvidence({
				environment,
				expectedOperationId: operationId,
				payload: evidencePayload(),
			}),
		).rejects.toThrow();
	});
});
