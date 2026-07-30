import { expect } from 'vitest';

import { waitForProtocolRetryInterval } from './e2e-protocol-wait.js';

/* oxlint-disable eslint/no-await-in-loop -- helpers wait on external protocol state */

export function expectProviderTransitionLogs(options: {
	readonly fallbackModelName: string;
	readonly logs: string;
	readonly primaryModelName: string;
}): void {
	expect(options.logs).toContain('"hermes.failover.reason"');
	const records = options.logs.split('\n');
	expect(
		records.some(
			(record) =>
				record.includes(options.primaryModelName) &&
				record.includes('"agent_vm.result.class":"failure"'),
		),
	).toBe(true);
	expect(
		records.some(
			(record) =>
				record.includes(options.fallbackModelName) &&
				record.includes('"agent_vm.result.class":"success"'),
		),
	).toBe(true);
}

export function requireTraceIdForSpan(records: string, spanName: string): string {
	for (const line of records.split('\n')) {
		if (line.length === 0) continue;
		const record: unknown = JSON.parse(line);
		if (
			typeof record === 'object' &&
			record !== null &&
			'name' in record &&
			record.name === spanName &&
			'trace_id' in record &&
			typeof record.trace_id === 'string'
		) {
			return record.trace_id;
		}
	}
	throw new Error(`Victoria did not return a trace id for span '${spanName}'.`);
}

export function selectStoredHermesFrameworkLogs(records: string): string {
	const frameworkOperationCategories = new Set(['provider_attempt', 'tool', 'turn']);
	return records
		.split('\n')
		.filter((line) => {
			if (line.length === 0) return false;
			const record: unknown = JSON.parse(line);
			return (
				typeof record === 'object' &&
				record !== null &&
				'service.name' in record &&
				record['service.name'] === 'agent-vm-hermes' &&
				'agent_vm.operation.category' in record &&
				typeof record['agent_vm.operation.category'] === 'string' &&
				frameworkOperationCategories.has(record['agent_vm.operation.category'])
			);
		})
		.join('\n');
}

export async function waitForVictoriaMetric(
	metricsPort: number,
	metricName: string,
): Promise<string> {
	const deadline = Date.now() + 45_000;
	let lastResponse = '';
	while (Date.now() < deadline) {
		const query = new URLSearchParams({ query: `{__name__=${JSON.stringify(metricName)}}` });
		const response = await fetch(
			`http://127.0.0.1:${String(metricsPort)}/api/v1/query?${query.toString()}`,
			{ signal: AbortSignal.timeout(10_000) },
		);
		if (!response.ok)
			throw new Error(`VictoriaMetrics query failed with HTTP ${String(response.status)}.`);
		lastResponse = await response.text();
		if (lastResponse.includes(metricName)) return lastResponse;
		await waitForProtocolRetryInterval(500);
	}
	throw new Error(`Timed out waiting for VictoriaMetrics '${metricName}': ${lastResponse}`);
}

export async function waitForVictoriaText(options: {
	readonly diagnostics?: (() => Promise<string>) | undefined;
	readonly endpoint: string;
	readonly expected: string | readonly string[];
	readonly query: string;
}): Promise<string> {
	const deadline = Date.now() + 45_000;
	const expectedValues =
		typeof options.expected === 'string' ? [options.expected] : options.expected;
	let lastResponse = '';
	while (Date.now() < deadline) {
		const response = await fetch(options.endpoint, {
			body: new URLSearchParams({ query: options.query }),
			method: 'POST',
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok)
			throw new Error(`Victoria query failed with HTTP ${String(response.status)}.`);
		lastResponse = await response.text();
		if (expectedValues.every((expectedValue) => lastResponse.includes(expectedValue))) {
			return lastResponse;
		}
		await waitForProtocolRetryInterval(500);
	}
	const diagnostics = options.diagnostics === undefined ? '' : await options.diagnostics();
	throw new Error(
		`Timed out waiting for Victoria '${expectedValues.join("', '")}': ${lastResponse}\n${diagnostics}`,
	);
}
