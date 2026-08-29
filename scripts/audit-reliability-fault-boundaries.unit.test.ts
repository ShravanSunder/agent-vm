import { describe, expect, it } from 'vitest';

import { auditReliabilityFaultBoundaries } from './audit-reliability-fault-boundaries.js';

describe('auditReliabilityFaultBoundaries', () => {
	it('finds raw destructive process and SSH reset faults in live proof sources', () => {
		const findings = auditReliabilityFaultBoundaries([
			{
				content: [
					'const script = `',
					'kill -KILL "$gateway_pid"',
					'kill -STOP "$gateway_pid"',
					'`;',
				].join('\n'),
				filePath:
					'packages/agent-vm/src/integration-tests/hermes-managed-base-environment.hermes.e2e.test.ts',
			},
			{
				content:
					"const staleTrigger = 'ssh-command-reset';\nconst command = 'kill -9 \\\"$target_pid\\\"';",
				filePath: 'packages/agent-vm/src/integration-tests/gateway-runtime-sandbox.vm.e2e.test.ts',
			},
		]);

		expect(findings).toEqual([
			{
				filePath: 'packages/agent-vm/src/integration-tests/gateway-runtime-sandbox.vm.e2e.test.ts',
				line: 1,
				reason: 'raw SSH reset fault',
			},
			{
				filePath: 'packages/agent-vm/src/integration-tests/gateway-runtime-sandbox.vm.e2e.test.ts',
				line: 2,
				reason: 'raw process kill fault',
			},
			{
				filePath:
					'packages/agent-vm/src/integration-tests/hermes-managed-base-environment.hermes.e2e.test.ts',
				line: 2,
				reason: 'raw process kill fault',
			},
			{
				filePath:
					'packages/agent-vm/src/integration-tests/hermes-managed-base-environment.hermes.e2e.test.ts',
				line: 3,
				reason: 'raw process stop fault',
			},
		]);
	});

	it('does not flag product disconnects, ownership probes, or typed adapters', () => {
		const findings = auditReliabilityFaultBoundaries([
			{
				content: 'socket.disconnect(true);\nprocess.kill(pid, 0);',
				filePath: 'packages/hermes-gateway/src/hermes-lifecycle.ts',
			},
			{
				content: 'kill -KILL "$owned_pid";',
				filePath:
					'packages/agent-vm/src/controller/reliability/testing/gateway-reliability-fault-adapter.ts',
			},
		]);

		expect(findings).toEqual([]);
	});

	it('forbids production exports and routes to the test-only fault surface', () => {
		const findings = auditReliabilityFaultBoundaries([
			{
				content: "export * from './controller/reliability/testing/reliability-fault-port.js';",
				filePath: 'packages/agent-vm/src/index.ts',
			},
			{
				content: "router.post('/reliability-fault', handleFault);",
				filePath: 'packages/agent-vm/src/controller/controller-router.ts',
			},
			{
				content: "process.kill(targetPid, 'SIGKILL');",
				filePath:
					'packages/agent-vm/src/integration-tests/hermes-managed-base-environment.hermes.e2e.test.ts',
			},
		]);

		expect(findings.map((finding) => finding.reason)).toEqual([
			'production reliability fault route',
			'production export of reliability fault testing surface',
			'raw process kill fault',
		]);
	});
});
