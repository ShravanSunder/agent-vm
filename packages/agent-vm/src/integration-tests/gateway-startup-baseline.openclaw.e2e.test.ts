/* oxlint-disable eslint/no-await-in-loop -- benchmark samples are intentionally isolated and sequential. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createGatewayApiClient } from '../gateway-api-client/gateway-api-client.js';
import {
	canRunManagedVmE2e,
	currentE2eArchitecture,
	prepareGatewayE2eProjectImages,
	removeE2eTempRoot,
	scaffoldOpenClawE2eProject,
	startE2eControllerRuntime,
	type E2eHarnessRuntime,
	useLocalOpenClawGatewayImagePackages,
} from './e2e-harness.js';

const architecture = currentE2eArchitecture();
const runBenchmark =
	process.env.AGENT_VM_OPENCLAW_E2E === '1' && (await canRunManagedVmE2e({ architecture }));
const describeBenchmark = runBenchmark ? describe : describe.skip;
const agentId = 'startup-benchmark';
const gatewayToken = 'startup-benchmark-gateway-token';

interface StartupBenchmarkSample {
	readonly admissionMs: number;
	readonly externalReadyMs: number;
	readonly requestMs: number;
}

interface StartupBenchmarkReceipt {
	readonly cacheRoot: string;
	readonly fixtureVariant: string;
	readonly milestone: string;
	readonly requestPath: string;
	readonly sampleCount: number;
	readonly samples: readonly StartupBenchmarkSample[];
	readonly sourceHead: string;
	readonly summary: {
		readonly admissionMs: BenchmarkSummary;
		readonly externalReadyMs: BenchmarkSummary;
		readonly requestMs: BenchmarkSummary;
	};
	readonly warmupCount: number;
}

interface BenchmarkSummary {
	readonly max: number;
	readonly median: number;
	readonly min: number;
	readonly p90: number;
}

function positiveIntegerFromEnv(envName: string, fallback: number): number {
	const rawValue = process.env[envName];
	if (rawValue === undefined || rawValue.length === 0) {
		return fallback;
	}
	const parsedValue = Number(rawValue);
	if (!Number.isInteger(parsedValue) || parsedValue < 0) {
		throw new Error(`${envName} must be a non-negative integer.`);
	}
	return parsedValue;
}

function percentile(sortedSamples: readonly number[], percentileValue: number): number {
	const index = Math.max(
		0,
		Math.min(sortedSamples.length - 1, Math.ceil(sortedSamples.length * percentileValue) - 1),
	);
	return sortedSamples[index] ?? 0;
}

function summarize(samples: readonly number[]): BenchmarkSummary {
	const sortedSamples = [...samples].toSorted((left, right) => left - right);
	return {
		max: sortedSamples.at(-1) ?? 0,
		median: percentile(sortedSamples, 0.5),
		min: sortedSamples[0] ?? 0,
		p90: percentile(sortedSamples, 0.9),
	};
}

describeBenchmark('e2e: legacy OpenClaw startup availability benchmark', () => {
	const openHarnesses = new Set<E2eHarnessRuntime>();
	const tempRoots = new Set<string>();

	afterAll(async () => {
		for (const harness of openHarnesses) {
			await harness.close().catch(() => undefined);
		}
		for (const tempRoot of tempRoots) {
			await removeE2eTempRoot(tempRoot);
		}
	});

	it('records first successful authenticated root-ingress request after controller admission', async () => {
		const repoRoot = path.resolve(process.cwd());
		const sampleCount = positiveIntegerFromEnv('AGENT_VM_GATEWAY_STARTUP_BENCHMARK_SAMPLES', 10);
		const warmupCount = positiveIntegerFromEnv('AGENT_VM_GATEWAY_STARTUP_BENCHMARK_WARMUPS', 1);
		if (sampleCount === 0) {
			throw new Error('AGENT_VM_GATEWAY_STARTUP_BENCHMARK_SAMPLES must be greater than zero.');
		}
		const samples: StartupBenchmarkSample[] = [];
		for (let sampleIndex = 0; sampleIndex < warmupCount + sampleCount; sampleIndex += 1) {
			const project = await scaffoldOpenClawE2eProject({
				agents: [agentId],
				architecture,
				prefix: `gateway-startup-baseline-${String(sampleIndex)}-`,
				zoneId: `gateway-startup-baseline-${String(sampleIndex)}`,
			});
			tempRoots.add(project.tempRoot);
			const zone = project.systemConfig.zones[0];
			if (zone === undefined || zone.gateway.type !== 'openclaw') {
				throw new Error('Expected an OpenClaw benchmark zone.');
			}
			await useLocalOpenClawGatewayImagePackages({
				profileName: zone.gateway.imageProfile,
				projectRoot: project.tempRoot,
				repoRoot,
				systemConfig: project.systemConfig,
			});
			await prepareGatewayE2eProjectImages({ project });

			const startedAt = performance.now();
			const harness = await startE2eControllerRuntime({
				secrets: {
					GITHUB_TOKEN: 'unused-startup-benchmark-github-token',
					OPENCLAW_GATEWAY_TOKEN: gatewayToken,
					PERPLEXITY_API_KEY: 'unused-startup-benchmark-perplexity-token',
				},
				startOptions: {
					systemConfig: project.systemConfig,
					zoneIds: [zone.id],
				},
			});
			openHarnesses.add(harness);
			const gatewayIngress = harness.runtime.zones[0]?.gateway?.ingress;
			if (gatewayIngress === undefined) {
				throw new Error('Controller returned without an admitted framework root ingress.');
			}
			const requestStartedAt = performance.now();
			const toolResult = await createGatewayApiClient({
				gatewayUrl: `http://${gatewayIngress.host}:${String(gatewayIngress.port)}`,
				token: gatewayToken,
			}).invokeTool({
				agentId,
				args: { requests: [{ id: 'startup' }] },
				tool: 'tool_portal_list',
			});
			const serializedToolResult = JSON.stringify(toolResult);
			expect(serializedToolResult).toContain('startup');
			expect(serializedToolResult).toContain('ok');
			const succeededAt = performance.now();
			if (sampleIndex >= warmupCount) {
				samples.push({
					admissionMs: Math.round((requestStartedAt - startedAt) * 100) / 100,
					externalReadyMs: Math.round((succeededAt - startedAt) * 100) / 100,
					requestMs: Math.round((succeededAt - requestStartedAt) * 100) / 100,
				});
			}
			await harness.close();
			openHarnesses.delete(harness);
			tempRoots.delete(project.tempRoot);
		}

		const receipt = {
			cacheRoot: process.env.AGENT_VM_E2E_CACHE_DIR ?? '(default)',
			fixtureVariant:
				process.env.AGENT_VM_GATEWAY_STARTUP_BENCHMARK_VARIANT ?? 'legacy-controller-launched',
			milestone:
				'first successful authenticated tool_portal_list request through framework root ingress after controller admission',
			requestPath: '/tools/invoke',
			sampleCount,
			samples,
			sourceHead: '31c82599414c337c37c60d6a41fb799af4813e69',
			summary: {
				admissionMs: summarize(samples.map((sample) => sample.admissionMs)),
				externalReadyMs: summarize(samples.map((sample) => sample.externalReadyMs)),
				requestMs: summarize(samples.map((sample) => sample.requestMs)),
			},
			warmupCount,
		} satisfies StartupBenchmarkReceipt;
		const receiptPath = process.env.AGENT_VM_STARTUP_BENCHMARK_RECEIPT;
		if (receiptPath !== undefined && receiptPath.length > 0) {
			await mkdir(path.dirname(receiptPath), { recursive: true });
			await writeFile(receiptPath, `${JSON.stringify(receipt, null, '\t')}\n`, 'utf8');
		}
		process.stdout.write(`AGENT_VM_STARTUP_BENCHMARK ${JSON.stringify(receipt)}\n`);
	});
});
