import {
	configuredCliPolicySchema,
	managedToolPortalConfigSchema,
	mcpConfigSchema,
	type ManagedToolPortalConfig,
	type McpConfig,
} from '@agent-vm/config-contracts';

export interface PortalCompositionFixtureConfig {
	readonly mcpConfig: McpConfig;
	readonly toolPortalConfig: ManagedToolPortalConfig;
}

export interface BuildPortalCompositionFixtureConfigOptions {
	readonly agentId: string;
	readonly configuredCliNamespace: string;
	readonly credentialedEffectOperationName: string;
	readonly credentialedImageReference: string;
	readonly credentialedRuntimeHost: string;
	readonly credentialedRuntimeSecretEnvironmentName: string;
	readonly credentialedScriptBody: string;
	readonly fakeUpstreamNamespace: string;
	readonly hostCwd: string;
	readonly hostEffectOperationName: string;
	readonly hostScriptBody: string;
	readonly hiddenHostEffectOperationName: string;
	readonly lossProbeOperationName: string;
	readonly lossScriptBody: string;
	readonly mcpUrl: string;
	readonly toolVmArtifactNamespace: string;
	readonly toolVmArtifactOperationName: string;
}

export function buildPortalCompositionHostScriptBody(options: {
	readonly barrierFifoPath: string;
	readonly barrierReadyPath: string;
	readonly concurrencyOrderPath: string;
	readonly hostEffectPath: string;
	readonly hiddenHostEffectPath: string;
}): string {
	return [
		'import json, os, pathlib, sys',
		`effect_path = pathlib.Path(${JSON.stringify(options.hostEffectPath)})`,
		'forged_effect_path = pathlib.Path(str(effect_path) + ".forged")',
		`hidden_effect_path = pathlib.Path(${JSON.stringify(options.hiddenHostEffectPath)})`,
		`barrier_fifo_path = pathlib.Path(${JSON.stringify(options.barrierFifoPath)})`,
		`barrier_ready_path = pathlib.Path(${JSON.stringify(options.barrierReadyPath)})`,
		`order_path = pathlib.Path(${JSON.stringify(options.concurrencyOrderPath)})`,
		'def append_event(event):',
		'    with order_path.open("a", encoding="utf-8") as order_file:',
		'        order_file.write(event + "\\n")',
		'        order_file.flush()',
		'command = sys.argv[1]',
		'if command == "write-host-effect":',
		'    effect_path.write_text(json.dumps({"argv": sys.argv[1:], "destination": "controller-host"}, sort_keys=True), encoding="utf-8")',
		'    if sys.argv[2] == "forged-overwrite": forged_effect_path.write_text("forged-dispatch\\n", encoding="utf-8")',
		'    result = {"destination": "controller-host", "value": sys.argv[2]}',
		'elif command == "write-hidden-effect":',
		'    hidden_effect_path.write_text("policy-leak\\n", encoding="utf-8")',
		'    result = {"destination": "hidden-controller-host"}',
		'elif command == "prepare-concurrency-barrier":',
		'    barrier_ready_path.unlink(missing_ok=True)',
		'    barrier_fifo_path.unlink(missing_ok=True)',
		'    order_path.unlink(missing_ok=True)',
		'    os.mkfifo(barrier_fifo_path)',
		'    os.mkfifo(barrier_ready_path)',
		'    append_event("prepared")',
		'    result = {"barrier": "prepared"}',
		'elif command == "wait-concurrency-slow":',
		'    if not barrier_fifo_path.exists(): raise RuntimeError("concurrency FIFO was not prepared")',
		'    append_event("slow-admitted")',
		'    with barrier_ready_path.open("wb", buffering=0) as ready_writer:',
		'        ready_writer.write(b"R")',
		'    with barrier_fifo_path.open("rb", buffering=0) as barrier_reader:',
		'        if barrier_reader.read(1) != b"1": raise RuntimeError("concurrency barrier release was invalid")',
		'    append_event("slow-completed")',
		'    result = {"concurrency": "slow-completed", "value": sys.argv[2]}',
		'elif command == "return-concurrency-fast":',
		'    with barrier_ready_path.open("rb", buffering=0) as ready_reader:',
		'        if ready_reader.read(1) != b"R": raise RuntimeError("slow admission barrier was invalid")',
		'    append_event("fast-completed")',
		'    result = {"concurrency": "fast-completed", "value": sys.argv[2]}',
		'elif command == "release-concurrency-barrier":',
		'    if not barrier_fifo_path.exists(): raise RuntimeError("slow call was not ready for release")',
		'    append_event("release-started")',
		'    with barrier_fifo_path.open("wb", buffering=0) as barrier_writer:',
		'        barrier_writer.write(b"1")',
		'    result = {"barrier": "released"}',
		'else:',
		'    raise RuntimeError("unexpected host fixture command")',
		'print(json.dumps(result, sort_keys=True), end="")',
	].join('\n');
}

export function buildPortalCompositionLossScriptBody(options: {
	readonly lossFifoPath: string;
	readonly lossFastTimestampPath: string;
	readonly lossOrderPath: string;
	readonly lossPidPath: string;
	readonly lossReadyPath: string;
}): string {
	return [
		'import json, os, pathlib, sys, time',
		`loss_fifo_path = pathlib.Path(${JSON.stringify(options.lossFifoPath)})`,
		`loss_fast_timestamp_path = pathlib.Path(${JSON.stringify(options.lossFastTimestampPath)})`,
		`loss_ready_path = pathlib.Path(${JSON.stringify(options.lossReadyPath)})`,
		`loss_order_path = pathlib.Path(${JSON.stringify(options.lossOrderPath)})`,
		`loss_pid_path = pathlib.Path(${JSON.stringify(options.lossPidPath)})`,
		'command = sys.argv[1]',
		'if command == "prepare-loss-probe":',
		'    loss_ready_path.unlink(missing_ok=True); loss_fifo_path.unlink(missing_ok=True); loss_order_path.unlink(missing_ok=True); loss_pid_path.unlink(missing_ok=True); loss_fast_timestamp_path.unlink(missing_ok=True)',
		'    os.mkfifo(loss_fifo_path); os.mkfifo(loss_ready_path)',
		'    loss_order_path.write_text("loss-prepared\\n", encoding="utf-8")',
		'    result = {"lossProbe": "prepared"}',
		'elif command == "wait-loss-slow":',
		'    loss_pid_path.write_text(str(os.getpid()) + "\\n", encoding="utf-8")',
		'    with loss_order_path.open("a", encoding="utf-8") as output: output.write("loss-admitted\\n"); output.flush()',
		'    with loss_ready_path.open("wb", buffering=0) as output: output.write(b"R")',
		'    with loss_fifo_path.open("rb", buffering=0) as source: source.read(1)',
		'    with loss_order_path.open("a", encoding="utf-8") as output: output.write("loss-completed\\n")',
		'    result = {"lossProbe": "unexpectedly-completed"}',
		'elif command == "return-loss-fast":',
		'    with loss_ready_path.open("rb", buffering=0) as source:',
		'        if source.read(1) != b"R": raise RuntimeError("loss admission barrier was invalid")',
		'    loss_fast_timestamp_path.write_text(str(time.time_ns() // 1_000_000) + "\\n", encoding="utf-8")',
		'    with loss_order_path.open("a", encoding="utf-8") as output: output.write("loss-fast\\n")',
		'    result = {"lossProbe": "fast", "value": sys.argv[2]}',
		'else: raise RuntimeError("unexpected loss fixture command")',
		'print(json.dumps(result, sort_keys=True), end="")',
	].join('\n');
}

/** Encode multiline Python without placing control characters in a CLI argv token. */
export function pythonSourceCliArgument(source: string): string {
	return `exec(${JSON.stringify(source)})`;
}

export function buildPortalCompositionFixtureConfig(
	options: BuildPortalCompositionFixtureConfigOptions,
): PortalCompositionFixtureConfig {
	const credentialedEffectCliPolicy = configuredCliPolicySchema.parse({
		calls: { deny: [], requiresApproval: [], withoutApproval: 'remaining_admitted' },
		commands: [
			{ flagRules: [], path: ['write-credentialed-effect'] },
			{ flagRules: [], path: ['read-credentialed-effect'] },
		],
		deniedPatterns: [],
		stdin: { kind: 'none' },
		timeout: { kind: 'quick' },
	});
	const hostEffectCliPolicy = configuredCliPolicySchema.parse({
		calls: { deny: [], requiresApproval: [], withoutApproval: 'remaining_admitted' },
		commands: [
			{ flagRules: [], path: ['write-host-effect'] },
			{ flagRules: [], path: ['prepare-concurrency-barrier'] },
			{ flagRules: [], path: ['wait-concurrency-slow'] },
			{ flagRules: [], path: ['return-concurrency-fast'] },
			{ flagRules: [], path: ['release-concurrency-barrier'] },
		],
		deniedPatterns: [],
		stdin: { kind: 'none' },
		timeout: { kind: 'quick' },
	});
	const hiddenHostEffectCliPolicy = configuredCliPolicySchema.parse({
		calls: { deny: [], requiresApproval: [], withoutApproval: 'remaining_admitted' },
		commands: [{ flagRules: [], path: ['write-hidden-effect'] }],
		deniedPatterns: [],
		stdin: { kind: 'none' },
		timeout: { kind: 'quick' },
	});
	const lossProbeCliPolicy = configuredCliPolicySchema.parse({
		calls: { deny: [], requiresApproval: [], withoutApproval: 'remaining_admitted' },
		commands: [
			{ flagRules: [], path: ['prepare-loss-probe'] },
			{ flagRules: [], path: ['wait-loss-slow'] },
			{ flagRules: [], path: ['return-loss-fast'] },
		],
		deniedPatterns: [],
		stdin: { kind: 'none' },
		timeout: { kind: 'open' },
	});
	const mcpConfig = mcpConfigSchema.parse({
		providers: {
			composition: {
				discovery: { summary: 'Deterministic portal composition MCP fixture' },
				kind: 'mcp',
				namespace: options.fakeUpstreamNamespace,
				transport: { kind: 'streamable-http', url: options.mcpUrl },
			},
		},
		schemaVersion: 1,
	});
	const toolPortalConfig = managedToolPortalConfigSchema.parse({
		agents: { [options.agentId]: { profile: options.agentId } },
		mode: 'managed',
		profiles: {
			[options.agentId]: {
				namespaces: {
					[options.toolVmArtifactNamespace]: {
						backend: {
							kind: 'tool_vm_runner',
							operations: {
								[options.toolVmArtifactOperationName]: {
									description: 'Read the deterministic composition artifact payload.',
									kind: 'filesystem.read',
								},
							},
							profile: 'sandbox_ssh',
						},
						calls: {
							requiresApproval: { allow: [] },
							withoutApproval: { allow: [options.toolVmArtifactOperationName] },
						},
						tools: { allow: [options.toolVmArtifactOperationName] },
					},
					[options.configuredCliNamespace]: {
						backend: {
							kind: 'controller_execution',
							operations: {
								[options.credentialedEffectOperationName]: {
									...credentialedEffectCliPolicy,
									executablePath: '/opt/agent-vm-tools/bin/python',
									executionTarget: {
										allowedHosts: [options.credentialedRuntimeHost],
										credentialProjection: {
											environment: {
												PORTAL_COMPOSITION_PROOF_TOKEN: {
													hosts: [options.credentialedRuntimeHost],
													secret: {
														name: options.credentialedRuntimeSecretEnvironmentName,
														source: 'environment',
													},
												},
											},
											kind: 'http_mediation',
										},
										environment: { kind: 'empty' },
										guestCwd: '/tmp',
										imageReference: options.credentialedImageReference,
										kind: 'ephemeral_managed_vm',
									},
									kind: 'configured_cli',
									mandatoryArgvPrefix: [
										'-c',
										pythonSourceCliArgument(options.credentialedScriptBody),
									],
									output: {
										modelVisibleStderr: 'none',
										overflow: 'fail',
										stderrMaxBytes: 4096,
										stdoutMaxBytes: 4096,
									},
									safeHelp: 'Write the credentialed-runtime composition fixture.',
								},
								[options.hostEffectOperationName]: {
									...hostEffectCliPolicy,
									executablePath: '/usr/bin/python3',
									executionTarget: {
										cwd: options.hostCwd,
										environment: { kind: 'empty' },
										kind: 'controller_host',
									},
									kind: 'configured_cli',
									mandatoryArgvPrefix: ['-c', pythonSourceCliArgument(options.hostScriptBody)],
									output: {
										modelVisibleStderr: 'none',
										overflow: 'fail',
										stderrMaxBytes: 4096,
										stdoutMaxBytes: 4096,
									},
									safeHelp: 'Write the controller-host composition fixture.',
								},
								[options.hiddenHostEffectOperationName]: {
									...hiddenHostEffectCliPolicy,
									executablePath: '/usr/bin/python3',
									executionTarget: {
										cwd: options.hostCwd,
										environment: { kind: 'empty' },
										kind: 'controller_host',
									},
									kind: 'configured_cli',
									mandatoryArgvPrefix: ['-c', pythonSourceCliArgument(options.hostScriptBody)],
									output: {
										modelVisibleStderr: 'none',
										overflow: 'fail',
										stderrMaxBytes: 4096,
										stdoutMaxBytes: 4096,
									},
									safeHelp: 'Hidden policy-denial fixture that must never execute.',
								},
								[options.lossProbeOperationName]: {
									...lossProbeCliPolicy,
									executablePath: '/usr/bin/python3',
									executionTarget: {
										cwd: options.hostCwd,
										environment: { kind: 'empty' },
										kind: 'controller_host',
									},
									kind: 'configured_cli',
									mandatoryArgvPrefix: ['-c', pythonSourceCliArgument(options.lossScriptBody)],
									output: {
										modelVisibleStderr: 'none',
										overflow: 'fail',
										stderrMaxBytes: 4096,
										stdoutMaxBytes: 4096,
									},
									safeHelp: 'Invocation-local relay loss uncertainty fixture.',
								},
							},
						},
						calls: {
							requiresApproval: { allow: [] },
							withoutApproval: {
								allow: [
									options.hostEffectOperationName,
									options.credentialedEffectOperationName,
									options.hiddenHostEffectOperationName,
									options.lossProbeOperationName,
								],
							},
						},
						tools: {
							allow: [
								options.hostEffectOperationName,
								options.credentialedEffectOperationName,
								options.hiddenHostEffectOperationName,
								options.lossProbeOperationName,
							],
							deny: [options.hiddenHostEffectOperationName],
						},
					},
					[options.fakeUpstreamNamespace]: {
						backend: { kind: 'mcp_provider' },
						calls: {
							requiresApproval: { allow: [] },
							withoutApproval: { allow: ['read_thing', 'write_thing'] },
						},
						tools: { allow: ['read_thing', 'write_thing'] },
					},
				},
			},
		},
		schemaVersion: 1,
	});
	return { mcpConfig, toolPortalConfig };
}
