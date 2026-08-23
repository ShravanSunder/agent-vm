import { describe, expect, it } from 'vitest';

import {
	reliabilityEvidenceManifestSchema,
	reliabilityScenarioEvidenceSchema,
	validateReliabilityEvidenceManifest,
} from './reliability-evidence-manifest.js';

function createReceipt(operationId: string, index: number): Record<string, unknown> {
	return {
		artifacts: [{ operationId: 'vitest-json', sha256: 'b'.repeat(64) }],
		dirtyHash: 'c'.repeat(64),
		exitCode: 0,
		failedTests: 0,
		fileCount: 1,
		headSha: 'a'.repeat(40),
		operationId,
		packageIdentities: [
			{
				checksumSha256: 'd'.repeat(64),
				name: '@agent-vm/agent-vm',
				version: '0.0.113',
			},
		],
		passedTests: 2,
		project: operationId === 'controller-restart-cleanup' ? 'e2e-vm' : 'e2e-hermes',
		receiptId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
		runId: 'reliability-run-a',
		schemaVersion: 1,
		skippedTests: 0,
		todoTests: 0,
		totalTests: 2,
	};
}

function createManifest(): Record<string, unknown> {
	return {
		createdAtMs: 2_000,
		dirtyHash: 'c'.repeat(64),
		headSha: 'a'.repeat(40),
		receipts: [
			createReceipt('control-session-recovery', 1),
			createReceipt('controller-restart-cleanup', 2),
		],
		runId: 'reliability-run-a',
		schemaVersion: 1,
	};
}

describe('validateReliabilityEvidenceManifest', () => {
	it('accepts typed operation receipts from mixed exact existing projects', () => {
		const manifest = createManifest();
		expect(reliabilityEvidenceManifestSchema.parse(manifest)).toEqual(manifest);
		expect(
			validateReliabilityEvidenceManifest(manifest, [
				{ operationId: 'control-session-recovery', project: 'e2e-hermes' },
				{ operationId: 'controller-restart-cleanup', project: 'e2e-vm' },
			]),
		).toEqual({ findings: [], ok: true });
	});

	it('rejects raw commands and host paths in receipts', () => {
		const manifest = createManifest();
		const receipts = manifest.receipts as Record<string, unknown>[];
		receipts[0] = { ...receipts[0], command: 'kill -9 1' };
		expect(validateReliabilityEvidenceManifest(manifest, [])).toMatchObject({ ok: false });
		const secondManifest = createManifest();
		const secondReceipts = secondManifest.receipts as Record<string, unknown>[];
		secondReceipts[0] = {
			...secondReceipts[0],
			artifacts: [{ operationId: '/tmp/private/result.json', sha256: 'b'.repeat(64) }],
		};
		expect(validateReliabilityEvidenceManifest(secondManifest, [])).toMatchObject({ ok: false });
	});

	it('rejects wrong or mixed head/run and fail/skip/todo/zero-test receipts', () => {
		const manifest = createManifest();
		const receipts = manifest.receipts as Record<string, unknown>[];
		receipts[0] = {
			...receipts[0],
			failedTests: 1,
			headSha: 'e'.repeat(40),
			passedTests: 0,
			runId: 'different-run',
			skippedTests: 1,
			todoTests: 1,
			totalTests: 3,
		};
		receipts[1] = { ...receipts[1], fileCount: 0, totalTests: 0, passedTests: 0 };

		const result = validateReliabilityEvidenceManifest(manifest, []);
		expect(result.ok).toBe(false);
		expect(result.findings.join('\n')).toMatch(/run identity/u);
		expect(result.findings.join('\n')).toMatch(/head identity/u);
		expect(result.findings.join('\n')).toMatch(/failed/u);
		expect(result.findings.join('\n')).toMatch(/skipped/u);
		expect(result.findings.join('\n')).toMatch(/todo/u);
		expect(result.findings.join('\n')).toMatch(/zero tests/u);
	});

	it('requires identities, rejects stale query windows, and detects leak canaries', () => {
		const manifest = createManifest();
		const receipts = manifest.receipts as Record<string, unknown>[];
		receipts[0] = {
			...receipts[0],
			queryIdentities: [
				{
					marker: 'marker-a',
					source: 'victoria',
					windowEndMs: 100,
					windowStartMs: 0,
				},
			],
		};
		const result = validateReliabilityEvidenceManifest(
			manifest,
			[
				{
					operationId: 'control-session-recovery',
					project: 'e2e-hermes',
					requireGenerationIdentity: true,
					requireProcessIdentity: true,
					requireQueryIdentity: true,
					requireRuntimeIdentity: true,
				},
			],
			{ leakCanaries: ['marker-a'], maxQueryAgeMs: 500, nowMs: 2_000 },
		);

		expect(result.ok).toBe(false);
		expect(result.findings.join('\n')).toMatch(/runtime identity/u);
		expect(result.findings.join('\n')).toMatch(/process identity/u);
		expect(result.findings.join('\n')).toMatch(/generation identity/u);
		expect(result.findings.join('\n')).toMatch(/stale query window/u);
		expect(result.findings.join('\n')).toMatch(/leak canary/u);
	});
});

describe('reliabilityScenarioEvidenceSchema', () => {
	const scenarioEvidence = {
		artifacts: [{ operationId: 'runtime-receipt', sha256: 'b'.repeat(64) }],
		dirtyHash: 'c'.repeat(64),
		generationIdentities: [{ generation: 2, targetId: 'gateway-a', targetKind: 'gateway' }],
		headSha: 'a'.repeat(40),
		operationId: 'control-session-recovery',
		packageIdentities: [
			{
				checksumSha256: 'd'.repeat(64),
				name: '@agent-vm/agent-vm',
				version: '0.0.113',
			},
		],
		processIdentities: [
			{ bootId: 'boot-a', kind: 'gateway', processId: 42, startIdentity: 'start-a' },
		],
		runId: 'reliability-run-a',
		runtimeIdentities: [{ generation: 2, id: 'runtime-a', kind: 'gateway' }],
		schemaVersion: 1,
	} as const;

	it('accepts bounded correlated identities and rejects forged fields or missing identities', () => {
		expect(reliabilityScenarioEvidenceSchema.parse(scenarioEvidence)).toEqual(scenarioEvidence);
		expect(
			reliabilityScenarioEvidenceSchema.safeParse({
				...scenarioEvidence,
				command: 'kill -9 1',
			}).success,
		).toBe(false);
		expect(
			reliabilityScenarioEvidenceSchema.safeParse({
				...scenarioEvidence,
				runtimeIdentities: [],
			}).success,
		).toBe(false);
	});
});
