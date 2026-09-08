/* oxlint-disable eslint/no-await-in-loop -- bounded host liveness observation must remain sequential */
import { access, mkdir, readFile, watch, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ManagedVmCreateRequest } from '@agent-vm/managed-vm';
import {
	fakeUpstreamNamespace,
	startFakeUpstreamMcpServer,
	type StartedFakeUpstreamMcpServer,
} from '@agent-vm/mcp-portal/testing/fake-upstream-mcp-server';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import type { GatewayZoneVmOperations } from '../gateway/gateway-zone-support.js';
import { controllerFixedGatewayRuntimeArtifactLimits } from '../gateway/managed-gateway-runtime-input-builders.js';
import {
	canRunManagedVmE2e,
	currentE2eArchitecture,
	prepareGatewayE2eProjectImages,
	removeE2eTempRoot,
	startE2eControllerRuntime,
	type E2eHarnessRuntime,
} from './e2e-harness.js';
import { waitForProtocolRetryInterval } from './e2e-protocol-wait.js';
import {
	buildHermesE2eProfileApiServerKeySecrets,
	hermesE2eProfileApiServerKey,
	hermesE2eProfileApiServerKeyEnvironmentName,
	materializeLocalHermesGatewayImagePackages,
	renderHermesManagedE2eConfiguration,
	scaffoldHermesE2eProject,
	type HermesE2eProject,
} from './hermes-e2e-harness.js';
import {
	buildPortalCompositionFixtureConfig,
	buildPortalCompositionHostScriptBody,
	buildPortalCompositionLossScriptBody,
} from './portal-composition-hermes-e2e-config.js';
import {
	buildPortalCompositionProgram as buildSharedPortalCompositionProgram,
	portalCompositionArtifactNamespace,
	portalCompositionArtifactOperationName,
	portalCompositionLossCancellationWindowMilliseconds,
	portalCompositionLossProbeOperationName,
	validatePortalCompositionGeneratedProgramSyntax,
} from './portal-composition-hermes-e2e-program.js';
import {
	requestPortalCompositionHermesTurn,
	startPortalCompositionModelServer,
	waitForPortalCompositionHermesHealth,
} from './portal-composition-hermes-e2e-support.js';

const architecture = currentE2eArchitecture();
const runPortalCompositionHermesE2e =
	process.env.AGENT_VM_HERMES_E2E === '1' && (await canRunManagedVmE2e({ architecture }));
const describePortalCompositionHermesE2e = runPortalCompositionHermesE2e ? describe : describe.skip;

const agentId = 'main';
const configuredCliNamespace = 'portal_composition_execution';
const credentialedEffectOperationName = 'credentialed_effect';
const credentialedRuntimeSecretEnvironmentName = 'AGENT_VM_PORTAL_COMPOSITION_CREDENTIALED_TOKEN';
const credentialedRuntimeHost = 'portal-composition-credential.invalid';
const fakeMcpHost = 'portal-composition-mcp.vm.host';
const finalMarker = 'portal-composition-hermes-complete';
const hostOperationName = 'write_host_effect';
const hiddenHostEffectOperationName = 'hidden_host_effect';
const modelHost = 'portal-composition-model.vm.host';
const modelName = 'portal-composition-hermes-e2e';
const promptMarker = 'RUN_PORTAL_COMPOSITION_E2E';
const programResultMarker = 'portal-composition-program-complete';
const resultDerivedValue = 'derived-from-read-thing';
const sessionId = 'portal-composition-hermes-session';
const toolVmEffectOperationName = 'write_tool_vm_effect';

function hostProcessIsAlive(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return true;
	} catch (error: unknown) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') {
			return false;
		}
		throw error;
	}
}

async function observeLossProbeProcessExit(options: {
	readonly timestampPath: string;
	readonly pidPath: string;
	readonly signal: AbortSignal;
}): Promise<void> {
	const readBarrier = async (): Promise<{ processId: number; startedAtMs: number } | undefined> => {
		const [pidText, timestampText] = await Promise.all([
			readFile(options.pidPath, 'utf8').catch(() => undefined),
			readFile(options.timestampPath, 'utf8').catch(() => undefined),
		]);
		if (pidText === undefined || timestampText === undefined) return undefined;
		if (!/^[1-9][0-9]*$/u.test(pidText.trim()) || !/^[1-9][0-9]*$/u.test(timestampText.trim())) {
			throw new Error('Loss-probe PID or fast timestamp was invalid.');
		}
		return {
			processId: Number.parseInt(pidText, 10),
			startedAtMs: Number.parseInt(timestampText, 10),
		};
	};
	let barrier = await readBarrier();
	if (barrier === undefined) {
		for await (const event of watch(path.dirname(options.pidPath), {
			signal: AbortSignal.any([options.signal, AbortSignal.timeout(180_000)]),
		})) {
			void event;
			barrier = await readBarrier();
			if (barrier !== undefined) break;
		}
	}
	if (barrier === undefined) throw new Error('Loss-probe host barrier was never observed.');
	const deadline = barrier.startedAtMs + portalCompositionLossCancellationWindowMilliseconds;
	while (hostProcessIsAlive(barrier.processId) && Date.now() <= deadline) {
		options.signal.throwIfAborted();
		await waitForProtocolRetryInterval(50);
	}
	if (hostProcessIsAlive(barrier.processId) || Date.now() > deadline) {
		throw new Error(
			`Loss-probe host process ${String(barrier.processId)} did not exit within the cancellation window.`,
		);
	}
}

async function writePortalCompositionConfiguration(options: {
	readonly barrierFifoPath: string;
	readonly barrierReadyPath: string;
	readonly concurrencyOrderPath: string;
	readonly hostEffectPath: string;
	readonly hiddenHostEffectPath: string;
	readonly lossFifoPath: string;
	readonly lossFastTimestampPath: string;
	readonly lossOrderPath: string;
	readonly lossPidPath: string;
	readonly lossReadyPath: string;
	readonly mcpUrl: string;
	readonly project: HermesE2eProject;
}): Promise<void> {
	const configDirectory = path.join(options.project.tempRoot, 'config', 'tool-portal');
	await mkdir(configDirectory, { recursive: true });
	const credentialedImageReference = '../../vm-images/tool-vms/default/build-config.jsonc';
	const defaultToolVmProfile = options.project.systemConfig.imageProfiles.toolVms.default;
	if (
		defaultToolVmProfile === undefined ||
		path.resolve(configDirectory, credentialedImageReference) !== defaultToolVmProfile.buildConfig
	) {
		throw new Error(
			'Portal composition credentialed image reference did not resolve to the prepared default Tool VM recipe.',
		);
	}
	const hostScript = buildPortalCompositionHostScriptBody({
		barrierFifoPath: options.barrierFifoPath,
		barrierReadyPath: options.barrierReadyPath,
		concurrencyOrderPath: options.concurrencyOrderPath,
		hostEffectPath: options.hostEffectPath,
		hiddenHostEffectPath: options.hiddenHostEffectPath,
	});
	const lossScript = buildPortalCompositionLossScriptBody({
		lossFifoPath: options.lossFifoPath,
		lossFastTimestampPath: options.lossFastTimestampPath,
		lossOrderPath: options.lossOrderPath,
		lossPidPath: options.lossPidPath,
		lossReadyPath: options.lossReadyPath,
	});
	const credentialedScript = [
		'import json, os, pathlib, sys',
		'effect_path = pathlib.Path("/tmp/portal-composition-credentialed-effect.json")',
		'assert os.environ.get("PORTAL_COMPOSITION_PROOF_TOKEN")',
		'command = sys.argv[1]',
		'if command == "write-credentialed-effect":',
		'    effect_path.write_text(json.dumps({"destination": "credentialed-runtime", "value": sys.argv[2]}, sort_keys=True), encoding="utf-8")',
		'    result = {"destination": "credentialed-runtime-effect-written"}',
		'elif command == "read-credentialed-effect":',
		'    result = {"effect": json.loads(effect_path.read_text(encoding="utf-8")), "destination": "credentialed-runtime-effect-read"}',
		'else:',
		'    raise RuntimeError("unexpected credentialed fixture command")',
		'print(json.dumps(result, sort_keys=True), end="")',
	].join('\n');
	const { mcpConfig, toolPortalConfig } = buildPortalCompositionFixtureConfig({
		agentId,
		configuredCliNamespace,
		credentialedEffectOperationName,
		credentialedImageReference,
		credentialedRuntimeHost,
		credentialedRuntimeSecretEnvironmentName,
		credentialedScriptBody: credentialedScript,
		fakeUpstreamNamespace,
		hostCwd: options.project.tempRoot,
		hostEffectOperationName: hostOperationName,
		hostScriptBody: hostScript,
		hiddenHostEffectOperationName,
		lossProbeOperationName: portalCompositionLossProbeOperationName,
		lossScriptBody: lossScript,
		mcpUrl: options.mcpUrl,
		toolVmArtifactNamespace: portalCompositionArtifactNamespace,
		toolVmArtifactOperationName: portalCompositionArtifactOperationName,
		toolVmEffectOperationName,
	});
	await Promise.all([
		writeFile(
			path.join(configDirectory, 'mcp.config.jsonc'),
			`${JSON.stringify(mcpConfig, null, '\t')}\n`,
			'utf8',
		),
		writeFile(
			path.join(configDirectory, 'tool-portal.config.jsonc'),
			`${JSON.stringify(toolPortalConfig, null, '\t')}\n`,
			'utf8',
		),
	]);
	const zone = options.project.systemConfig.zones[0];
	if (zone === undefined || zone.gateway.type !== 'hermes') {
		throw new Error('Portal composition E2E requires a Hermes zone.');
	}
	zone.toolPortal = {
		configDir: configDirectory,
		surfaceEligibilityByProfile: {
			[agentId]: {
				[configuredCliNamespace]: ['protected_uds'],
				[fakeUpstreamNamespace]: ['mcp', 'protected_uds'],
				[portalCompositionArtifactNamespace]: ['protected_uds'],
			},
		},
	};
}

describePortalCompositionHermesE2e('e2e: Tool VM Portal composition through Hermes', () => {
	let harness: E2eHarnessRuntime | undefined;
	let mcpServer: StartedFakeUpstreamMcpServer | undefined;
	let modelServer: Awaited<ReturnType<typeof startPortalCompositionModelServer>> | undefined;
	let project: HermesE2eProject | undefined;

	afterAll(async () => {
		await harness?.close({ preserveTempRoot: true });
		await Promise.allSettled([mcpServer?.close(), modelServer?.close()]);
		if (project !== undefined) await removeE2eTempRoot(project.tempRoot);
	});

	it('runs Python, Node, and CLI Portal calls from execute_code without moving composition to host', async () => {
		const repoRoot = path.resolve(process.cwd());
		project = await scaffoldHermesE2eProject({
			agents: [agentId],
			architecture,
			prefix: 'portal-composition-hermes-e2e-',
			zoneId: 'portal-composition-hermes-e2e',
		});
		const hostEffectPath = path.join(project.tempRoot, 'portal-composition-host-effect.json');
		const hiddenHostEffectPath = path.join(
			project.tempRoot,
			'portal-composition-hidden-host-effect.txt',
		);
		const hostSentinelPath = path.join(project.tempRoot, 'portal-composition-host-only-sentinel');
		const generatedProgram = buildSharedPortalCompositionProgram({ hostSentinelPath });
		await validatePortalCompositionGeneratedProgramSyntax(generatedProgram);
		const barrierFifoPath = path.join(project.tempRoot, 'portal-composition-concurrency.fifo');
		const barrierReadyPath = path.join(
			project.tempRoot,
			'portal-composition-concurrency-ready.fifo',
		);
		const concurrencyOrderPath = path.join(
			project.tempRoot,
			'portal-composition-concurrency-order.txt',
		);
		const lossFifoPath = path.join(project.tempRoot, 'portal-composition-loss.fifo');
		const lossFastTimestampPath = path.join(
			project.tempRoot,
			'portal-composition-loss-fast-timestamp.txt',
		);
		const lossReadyPath = path.join(project.tempRoot, 'portal-composition-loss-ready.fifo');
		const lossOrderPath = path.join(project.tempRoot, 'portal-composition-loss-order.txt');
		const lossPidPath = path.join(project.tempRoot, 'portal-composition-loss.pid');
		await writeFile(hostSentinelPath, 'host-only\n', 'utf8');
		[mcpServer, modelServer] = await Promise.all([
			startFakeUpstreamMcpServer(),
			startPortalCompositionModelServer({
				compositionProgram: generatedProgram.pythonProgram,
				finalMarker,
				promptMarker,
				programResultMarker,
			}),
		]);
		const zone = project.systemConfig.zones[0];
		if (zone === undefined || zone.gateway.type !== 'hermes') {
			throw new Error('Expected the portal composition Hermes zone.');
		}
		zone.gateway.profileSecretProjectionsByAgent[agentId] = {
			API_SERVER_KEY: hermesE2eProfileApiServerKeyEnvironmentName(agentId),
		};
		zone.egressHosts = [
			...(zone.egressHosts ?? []),
			{ audience: 'gateway', host: fakeMcpHost },
			{ audience: 'gateway', host: modelHost },
		];
		await writePortalCompositionConfiguration({
			barrierFifoPath,
			barrierReadyPath,
			concurrencyOrderPath,
			hostEffectPath,
			hiddenHostEffectPath,
			lossFifoPath,
			lossFastTimestampPath,
			lossOrderPath,
			lossPidPath,
			lossReadyPath,
			mcpUrl: `http://${fakeMcpHost}:${String(mcpServer.port)}/mcp`,
			project,
		});
		await writeFile(
			zone.gateway.config,
			renderHermesManagedE2eConfiguration({
				contextLength: 65_536,
				fakeModelBaseUrl: `http://${modelHost}:${String(modelServer.port)}/v1`,
				fakeModelHost: modelHost,
				fakeModelName: modelName,
			}),
			'utf8',
		);
		await materializeLocalHermesGatewayImagePackages({
			architecture,
			profileName: project.zone.gateway.imageProfile,
			projectRoot: project.tempRoot,
			repoRoot,
			systemConfig: project.systemConfig,
		});
		await prepareGatewayE2eProjectImages({ project });

		let gatewayVm: Pick<GatewayZoneVmOperations, 'exec'> | undefined;
		const controllerManagedVmRequests: ManagedVmCreateRequest[] = [];
		harness = await startE2eControllerRuntime({
			onControllerManagedVmCreateRequest: (request) => controllerManagedVmRequests.push(request),
			secrets: {
				...buildHermesE2eProfileApiServerKeySecrets([agentId]),
				[credentialedRuntimeSecretEnvironmentName]: 'portal-composition-fixture-token',
				GITHUB_TOKEN: 'unused-portal-composition-e2e-token',
			},
			startGatewayZone: async (startOptions, dependencies) => {
				const result = await startGatewayZone(startOptions, {
					...dependencies,
					gatewayRuntimeArtifactLimits: controllerFixedGatewayRuntimeArtifactLimits,
					managedVmFactory: {
						createManagedVm: async (request) => {
							const vm = await dependencies.managedVmFactory.createManagedVm(request);
							gatewayVm = vm;
							return vm;
						},
					},
				});
				if (result.executionModel !== 'managed-gateway') {
					throw new Error('Portal composition E2E requires a managed Gateway VM.');
				}
				gatewayVm = result.vm;
				return result;
			},
			startOptions: { systemConfig: project.systemConfig, zoneIds: [zone.id] },
			tcpHostsOverride: {
				[`${fakeMcpHost}:${String(mcpServer.port)}`]: `127.0.0.1:${String(mcpServer.port)}`,
				[`${modelHost}:${String(modelServer.port)}`]: `127.0.0.1:${String(modelServer.port)}`,
			},
		});
		await waitForPortalCompositionHermesHealth({
			controllerUrl: harness.controllerUrl,
			gatewayPort: project.gatewayPort,
			resolveVm: () => gatewayVm,
			zoneId: zone.id,
		});
		await mcpServer.firstListToolsRequest;

		const lossObservation = new AbortController();
		const [response] = await Promise.all([
			requestPortalCompositionHermesTurn({
				agentId,
				apiServerKey: hermesE2eProfileApiServerKey(agentId),
				gatewayPort: project.gatewayPort,
				modelName,
				prompt: promptMarker,
				sessionId,
			}).then((turnResponse) => {
				expect(
					turnResponse,
					`Raw execute_code result: ${modelServer?.latestExecuteCodeResult() ?? 'missing'}`,
				).toContain(finalMarker);
				return turnResponse;
			}),
			observeLossProbeProcessExit({
				pidPath: lossPidPath,
				timestampPath: lossFastTimestampPath,
				signal: lossObservation.signal,
			}),
		]).finally(() => lossObservation.abort());
		expect(
			response,
			`Raw execute_code result: ${modelServer.latestExecuteCodeResult() ?? 'missing'}`,
		).toContain(finalMarker);
		expect(modelServer.executeCodeRequestCount()).toBe(1);
		const executeCodeResult = modelServer.latestExecuteCodeResult();
		expect(executeCodeResult).toContain(programResultMarker);
		expect(executeCodeResult).toContain(resultDerivedValue);
		expect(executeCodeResult).toContain('hostSentinelVisible');
		expect(executeCodeResult).toContain('/opt/agent-vm-tools/bin/python');
		const executionEnvelope = z
			.object({ exit_code: z.literal(0), output: z.string(), status: z.literal('success') })
			.parse(JSON.parse(executeCodeResult ?? 'null'));
		const compositionOutput: unknown = JSON.parse(executionEnvelope.output);
		expect(compositionOutput).toMatchObject({
			toolVmConfiguredCli: {
				effect: resultDerivedValue,
				result: {
					ok: true,
					items: [
						{
							id: 'python-tool-vm-write',
							status: 'ok',
							outcome: { certainty: 'proven', completion: 'succeeded', kind: 'completed' },
							value: {
								exitCode: 0,
								stderrTruncated: false,
								stdout: `tool-vm:${resultDerivedValue}`,
								stdoutTruncated: false,
							},
						},
					],
				},
			},
		});
		expect(mcpServer.calls).toEqual([
			{ argumentsValue: { title: 'python-seed' }, name: 'read_thing' },
			{ argumentsValue: { title: resultDerivedValue }, name: 'write_thing' },
		]);
		expect(JSON.parse(await readFile(hostEffectPath, 'utf8'))).toEqual({
			argv: ['write-host-effect', resultDerivedValue],
			destination: 'controller-host',
		});
		await expect(access(`${hostEffectPath}.forged`)).rejects.toThrow();
		await expect(access(hiddenHostEffectPath)).rejects.toThrow();
		expect(await readFile(concurrencyOrderPath, 'utf8')).toBe(
			['prepared', 'slow-admitted', 'fast-completed', 'release-started', 'slow-completed', ''].join(
				'\n',
			),
		);
		expect(await readFile(lossOrderPath, 'utf8')).toBe(
			['loss-prepared', 'loss-admitted', 'loss-fast', ''].join('\n'),
		);
		await expect(access(hostSentinelPath)).resolves.toBeUndefined();
		const toolVmRequest = controllerManagedVmRequests.find(
			(request) => request.mounts['/workspace']?.kind === 'owned-filtered-workspace',
		);
		const workspaceMount = toolVmRequest?.mounts['/workspace'];
		if (workspaceMount?.kind !== 'owned-filtered-workspace') {
			throw new Error('Portal composition E2E did not observe the Tool VM workspace mount.');
		}
		const toolVmOrigin: unknown = JSON.parse(
			await readFile(
				path.join(
					workspaceMount.directory.identity.canonicalPath,
					'portal-composition-tool-vm-origin.json',
				),
				'utf8',
			),
		);
		expect(toolVmOrigin).toMatchObject({ hostSentinelVisible: false });
		expect(toolVmOrigin).toEqual({
			cwd: expect.stringMatching(/^\/tmp\/hermes_exec_[0-9a-f]{12}$/u),
			hostSentinelVisible: false,
			interpreter: expect.stringMatching(/^\/opt\/agent-vm-tools\/bin\/python(?:3(?:\.\d+)?)?$/u),
		});
		expect(
			controllerManagedVmRequests.some((request) =>
				request.sessionLabel.startsWith('credentialed-runtime-'),
			),
		).toBe(true);
		expect(
			controllerManagedVmRequests.some(
				(request) => !request.sessionLabel.startsWith('credentialed-runtime-'),
			),
		).toBe(true);
	}, 900_000);
});
