import {
	controllerEnforcedConfiguredCliOperationSchema,
	controllerToolVmConfiguredCliOperationSchema,
	toolPortalSelectorAllowsOperation,
} from '@agent-vm/config-contracts';
import { resolveCliAllowanceTimeout } from '@agent-vm/tool-portal/cli-allowances';
import { describe, expect, it } from 'vitest';

import {
	buildPortalCompositionFixtureConfig,
	buildPortalCompositionHostScriptBody,
	buildPortalCompositionLossScriptBody,
	pythonSourceCliArgument,
} from './portal-composition-hermes-e2e-config.js';
import {
	portalCompositionLossCancellationWindowMilliseconds,
	portalCompositionLossNaturalTimeoutMilliseconds,
} from './portal-composition-hermes-e2e-program.js';

describe('portal composition Hermes E2E fixture config', () => {
	it('parses the complete generated config with control-free executable arguments', () => {
		const multilinePython = ['if True:', '    print("fixture")'].join('\n');
		const hostPython = buildPortalCompositionHostScriptBody({
			barrierFifoPath: '/tmp/portal-composition-host/concurrency.fifo',
			barrierReadyPath: '/tmp/portal-composition-host/concurrency.ready',
			concurrencyOrderPath: '/tmp/portal-composition-host/concurrency-order.txt',
			hostEffectPath: '/tmp/portal-composition-host/host-effect.json',
			hiddenHostEffectPath: '/tmp/portal-composition-host/hidden-effect.txt',
		});
		const lossPython = buildPortalCompositionLossScriptBody({
			lossFifoPath: '/tmp/portal-composition-host/loss.fifo',
			lossFastTimestampPath: '/tmp/portal-composition-host/loss-fast-timestamp.txt',
			lossOrderPath: '/tmp/portal-composition-host/loss-order.txt',
			lossPidPath: '/tmp/portal-composition-host/loss.pid',
			lossReadyPath: '/tmp/portal-composition-host/loss-ready.fifo',
		});
		const config = buildPortalCompositionFixtureConfig({
			agentId: 'main',
			configuredCliNamespace: 'portal_composition_execution',
			credentialedEffectOperationName: 'credentialed_effect',
			credentialedImageReference: '../../vm-images/tool-vms/default/build-config.jsonc',
			credentialedRuntimeHost: 'portal-composition-credential.invalid',
			credentialedRuntimeSecretEnvironmentName: 'AGENT_VM_PORTAL_COMPOSITION_CREDENTIALED_TOKEN',
			credentialedScriptBody: multilinePython,
			fakeUpstreamNamespace: 'upstream-mock',
			hostCwd: '/tmp/portal-composition-host',
			hostEffectOperationName: 'write_host_effect',
			hostScriptBody: hostPython,
			hiddenHostEffectOperationName: 'hidden_host_effect',
			lossProbeOperationName: 'loss_probe',
			lossScriptBody: lossPython,
			mcpUrl: 'http://portal-composition-mcp.vm.host:31001/mcp',
			toolVmArtifactNamespace: 'portal_composition_sandbox',
			toolVmArtifactOperationName: 'read_payload',
			toolVmEffectOperationName: 'write_tool_vm_effect',
		});
		const namespace =
			config.toolPortalConfig.profiles.main?.namespaces['portal_composition_execution'];
		if (namespace?.backend.kind !== 'controller_execution') {
			throw new Error('Expected the fixture controller-execution namespace.');
		}
		const operation = namespace.backend.operations.credentialed_effect;
		if (operation?.kind !== 'configured_cli') {
			throw new Error('Expected the fixture credentialed configured CLI operation.');
		}
		const pythonArgument = operation.mandatoryArgvPrefix[1];
		if (pythonArgument === undefined) {
			throw new Error('Expected the fixture credentialed Python argument.');
		}
		expect(operation.mandatoryArgvPrefix).toEqual(['-c', pythonSourceCliArgument(multilinePython)]);
		expect(
			pythonArgument.split('').some((character) => {
				const codeUnit = character.charCodeAt(0);
				return codeUnit <= 31 || codeUnit === 127;
			}),
		).toBe(false);
		expect(config.mcpConfig.providers.composition?.namespace).toBe('upstream-mock');
		expect(config.toolPortalConfig.profiles.main?.namespaces.portal_composition_sandbox).toEqual({
			backend: {
				kind: 'tool_vm_runner',
				operations: {
					read_payload: {
						description: 'Read the deterministic composition artifact payload.',
						kind: 'filesystem.read',
					},
				},
				profile: 'sandbox_ssh',
			},
			calls: {
				requiresApproval: { allow: [], deny: [] },
				withoutApproval: { allow: ['read_payload'], deny: [] },
			},
			discovery: {},
			tools: { allow: ['read_payload'], deny: [] },
		});
		const hostOperation = controllerEnforcedConfiguredCliOperationSchema.parse(
			namespace.backend.operations.write_host_effect,
		);
		expect(hostOperation.commands.map(({ path }) => path)).toEqual([
			['write-host-effect'],
			['prepare-concurrency-barrier'],
			['wait-concurrency-slow'],
			['return-concurrency-fast'],
			['release-concurrency-barrier'],
		]);
		expect(hostOperation.mandatoryArgvPrefix).toEqual(['-c', pythonSourceCliArgument(hostPython)]);
		expect(hostPython).toContain('os.mkfifo(barrier_fifo_path)');
		expect(hostPython).toContain('os.mkfifo(barrier_ready_path)');
		expect(hostPython).toContain('ready_reader.read(1) != b"R"');
		expect(hostPython).toContain('append_event("fast-completed")');
		expect(hostPython).toContain('barrier_writer.write(b"1")');
		const hiddenOperation = namespace.backend.operations.hidden_host_effect;
		expect(hiddenOperation).toMatchObject({
			commands: [{ flagRules: [], path: ['write-hidden-effect'] }],
			kind: 'configured_cli',
		});
		expect(namespace.calls.withoutApproval.allow).toContain('hidden_host_effect');
		expect(namespace.tools.allow).toContain('hidden_host_effect');
		expect(namespace.tools.deny).toContain('hidden_host_effect');
		expect(toolPortalSelectorAllowsOperation(namespace.tools, 'hidden_host_effect')).toBe(false);
		expect(toolPortalSelectorAllowsOperation(namespace.tools, 'write_host_effect')).toBe(true);
		expect(hostPython).toContain('hidden_effect_path.write_text("policy-leak\\n"');
		expect(hostPython).toContain('if sys.argv[2] == "forged-overwrite"');
		expect(hostPython).toContain('forged_effect_path.write_text("forged-dispatch\\n"');
		const toolVmOperation = controllerToolVmConfiguredCliOperationSchema.parse(
			namespace.backend.operations.write_tool_vm_effect,
		);
		expect(toolVmOperation).toMatchObject({
			executablePath: '/bin/sh',
			executionTarget: { kind: 'tool_vm', workingDirectory: '.' },
			kind: 'configured_cli',
			mandatoryArgvPrefix: [
				'-c',
				'test "$1" = "write-tool-vm-effect" || exit 64; printf %s "$2" > portal-composition-tool-vm-effect.txt; printf "tool-vm:%s" "$2"',
				'--',
			],
			suggestCalls: {
				suggestDeny: [],
				suggestRequiresApproval: [],
				suggestWithoutApproval: 'remaining_admitted',
			},
			suggestCommands: [{ flagRules: [], path: ['write-tool-vm-effect'] }],
		});
		expect(namespace.backend.operations.loss_probe).toMatchObject({
			commands: [
				{ path: ['prepare-loss-probe'] },
				{ path: ['wait-loss-slow'] },
				{ path: ['return-loss-fast'] },
			],
			kind: 'configured_cli',
			timeout: { kind: 'open' },
		});
		expect(namespace.calls.withoutApproval.allow).toContain('loss_probe');
		expect(namespace.tools.allow).toContain('loss_probe');
		expect(lossPython).toContain('output.write("loss-admitted\\n")');
		expect(lossPython).toContain('loss_pid_path.write_text(str(os.getpid())');
		expect(lossPython).toContain('loss_fast_timestamp_path.write_text(str(time.time_ns()');
		expect(
			resolveCliAllowanceTimeout({
				input: {
					argv: ['wait-loss-slow', 'derived'],
					reason: 'loss proof',
					timeoutMs: portalCompositionLossNaturalTimeoutMilliseconds,
				},
				kind: 'open',
			}),
		).toMatchObject({ resolvedTimeoutMs: portalCompositionLossNaturalTimeoutMilliseconds });
		expect(portalCompositionLossCancellationWindowMilliseconds).toBeLessThan(
			portalCompositionLossNaturalTimeoutMilliseconds,
		);
	});
});
