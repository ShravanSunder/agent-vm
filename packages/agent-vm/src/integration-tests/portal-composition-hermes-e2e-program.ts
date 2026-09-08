import { spawn } from 'node:child_process';

import { PortalSearchRequestSchema } from '@agent-vm/agent-portal-sdk';
import { fakeUpstreamNamespace } from '@agent-vm/mcp-portal/testing/fake-upstream-mcp-server';

const configuredCliNamespace = 'portal_composition_execution';
const hiddenHostEffectOperationName = 'hidden_host_effect';
const hostOperationName = 'write_host_effect';
const resultDerivedValue = 'derived-from-read-thing';
export const portalCompositionArtifactNamespace = 'portal_composition_sandbox';
export const portalCompositionArtifactOperationName = 'read_payload';
export const portalCompositionLossProbeOperationName = 'loss_probe';
export const portalCompositionLossNaturalTimeoutMilliseconds = 120_000;
export const portalCompositionLossCancellationWindowMilliseconds = 10_000;
const artifactPayloadRelativePath = 'portal-composition-artifact.bin';
const artifactPayloadByteLength = 256 * 3_840;
const artifactReadMaximumBytes = 16 * 1024 * 1024;
const pythonSearchRequest = PortalSearchRequestSchema.parse({
	requests: [{ id: 'python-search', limit: 20, query: 'read', schemaDetail: 'summary' }],
});

export interface PortalCompositionGeneratedProgram {
	readonly nodeProgram: string;
	readonly pythonProgram: string;
}

export function buildPortalCompositionProgram(options: {
	readonly hostSentinelPath: string;
}): PortalCompositionGeneratedProgram {
	const nodeProgram = [
		"import { createHash } from 'node:crypto';",
		"import { connectToolPortal } from '@agent-vm/agent-portal-sdk';",
		'const derivedValue = process.env.PORTAL_COMPOSITION_DERIVED_VALUE;',
		'const artifactReferenceJson = process.env.PORTAL_COMPOSITION_ARTIFACT_REFERENCE;',
		'const expectedArtifactSha256 = process.env.PORTAL_COMPOSITION_ARTIFACT_SHA256;',
		'if (!derivedValue) throw new Error("Python did not supply the MCP-derived value");',
		'if (!artifactReferenceJson || !expectedArtifactSha256) throw new Error("Python did not supply artifact verification context");',
		'const artifactReference = JSON.parse(artifactReferenceJson);',
		'const client = await connectToolPortal();',
		'function requireSuccessfulResult(result, expectedItemCount, label) {',
		'  if (!result.ok || result.items.length !== expectedItemCount || result.items.some((item) => item.status !== "ok")) throw new Error(label + " did not succeed: " + JSON.stringify(result));',
		'  return result;',
		'}',
		'try {',
		'  const normalResult = requireSuccessfulResult(await client.call({ calls: [',
		`    { arguments: { title: derivedValue }, id: 'node-mcp-write', name: 'write_thing', namespace: ${JSON.stringify(fakeUpstreamNamespace)} },`,
		`    { arguments: { argv: ['write-host-effect', derivedValue], reason: 'Hermes composition E2E' }, id: 'node-host-write', name: ${JSON.stringify(hostOperationName)}, namespace: ${JSON.stringify(configuredCliNamespace)} },`,
		'  ] }), 2, "normal Node Portal calls");',
		`  requireSuccessfulResult(await client.call({ calls: [{ arguments: { argv: ['prepare-concurrency-barrier'], reason: 'Prepare deterministic concurrency barrier' }, id: 'node-concurrency-prepare', name: ${JSON.stringify(hostOperationName)}, namespace: ${JSON.stringify(configuredCliNamespace)} }] }), 1, 'concurrency preparation');`,
		'  const completionOrder = [];',
		`  const slowResultPromise = client.call({ calls: [{ arguments: { argv: ['wait-concurrency-slow', derivedValue], reason: 'Wait behind deterministic concurrency barrier' }, id: 'node-concurrency-slow', name: ${JSON.stringify(hostOperationName)}, namespace: ${JSON.stringify(configuredCliNamespace)} }] }).then((result) => { requireSuccessfulResult(result, 1, 'slow concurrent call'); completionOrder.push('slow'); return result; });`,
		`  const fastResult = requireSuccessfulResult(await client.call({ calls: [{ arguments: { argv: ['return-concurrency-fast', derivedValue], reason: 'Return while independent slow call is admitted' }, id: 'node-concurrency-fast', name: ${JSON.stringify(hostOperationName)}, namespace: ${JSON.stringify(configuredCliNamespace)} }] }), 1, 'fast concurrent call');`,
		"  completionOrder.push('fast');",
		"  if (completionOrder.length !== 1 || completionOrder[0] !== 'fast') throw new Error('slow call completed before the deliberately faster independent call');",
		`  const releaseResult = requireSuccessfulResult(await client.call({ calls: [{ arguments: { argv: ['release-concurrency-barrier'], reason: 'Release only after fast result was received' }, id: 'node-concurrency-release', name: ${JSON.stringify(hostOperationName)}, namespace: ${JSON.stringify(configuredCliNamespace)} }] }), 1, 'concurrency release');`,
		"  completionOrder.push('release');",
		'  const slowResult = await slowResultPromise;',
		"  if (completionOrder.indexOf('slow') <= completionOrder.indexOf('fast')) throw new Error('independent Portal responses were not reversed');",
		`  const artifactRead = await client.artifacts.read({ maxBytes: ${String(artifactReadMaximumBytes)}, offsetBytes: 0, reference: artifactReference });`,
		"  const artifactBytes = Buffer.from(artifactRead.contentBase64, 'base64');",
		"  const artifactSha256 = createHash('sha256').update(artifactBytes).digest('hex');",
		`  if (artifactBytes.byteLength !== ${String(artifactPayloadByteLength)} || artifactSha256 !== expectedArtifactSha256 || artifactRead.truncated || JSON.stringify(artifactRead.reference) !== JSON.stringify(artifactReference)) throw new Error('Node artifact verification failed');`,
		'  process.stdout.write(JSON.stringify({ artifact: { byteLength: artifactBytes.byteLength, sha256: artifactSha256 }, completionOrder, fastResult, normalResult, releaseResult, slowResult }));',
		'} finally {',
		'  await client.close();',
		'}',
	].join('\n');
	const forgedRequest = {
		agentId: 'synthetic-other-agent',
		kind: 'request',
		operation: 'call',
		request: {
			calls: [
				{
					arguments: {
						argv: ['write-host-effect', 'forged-overwrite'],
						reason: 'synthetic misuse probe',
					},
					id: 'forged-host-write',
					name: hostOperationName,
					namespace: configuredCliNamespace,
				},
			],
		},
		requestId: 'forged-envelope',
		trustedContext: { principal: { agentId: 'synthetic-other-agent' } },
	};
	const pythonProgram = [
		'import asyncio',
		'import base64',
		'import hashlib',
		'import json',
		'import os',
		'import pathlib',
		'import re',
		'import signal',
		'import subprocess',
		'import sys',
		'from agent_vm_agent_portal_sdk import connect_tool_portal',
		'from agent_vm_agent_portal_sdk.local_tool_portal_transport import PortalConnectionUnavailableError',
		'from agent_vm_agent_portal_sdk.portal_relay_protocol import PortalRelayDecoder, encode_relay_frame',
		'',
		'async def read_relay_message(reader, decoder):',
		'    async with asyncio.timeout(5):',
		'        while True:',
		'            data = await reader.read(65536)',
		'            if not data:',
		'                return None',
		'            messages = decoder.feed(data)',
		'            if messages:',
		'                return messages[0]',
		'',
		'def encode_unvalidated_relay_frame(message):',
		'    body = json.dumps(message, separators=(",", ":"), sort_keys=True).encode("utf-8")',
		'    return f"Content-Length: {len(body)}\\r\\n\\r\\n".encode("ascii") + body',
		'',
		'def verify_artifact_read(result, reference, expected_bytes, expected_sha256):',
		'    decoded = base64.b64decode(result["contentBase64"], validate=True)',
		'    digest = hashlib.sha256(decoded).hexdigest()',
		'    if decoded != expected_bytes or digest != expected_sha256 or result["offsetBytes"] != 0 or result["truncated"] or result["reference"] != reference:',
		'        raise RuntimeError("artifact read did not return the exact authorized payload")',
		'    return {"byteLength": len(decoded), "sha256": digest}',
		'',
		'def terminate_exact_invocation_relay():',
		'    socket_path = os.environ["AGENT_VM_TOOL_PORTAL_SOCKET"]',
		'    module_name = "agent_vm_agent_portal_sdk.guest_portal_relay_process"',
		'    matches = []',
		'    for process_path in pathlib.Path("/proc").iterdir():',
		'        if not process_path.name.isdigit():',
		'            continue',
		'        try:',
		'            arguments = [part.decode("utf-8") for part in (process_path / "cmdline").read_bytes().split(b"\\0") if part]',
		'        except (FileNotFoundError, PermissionError, ProcessLookupError, UnicodeDecodeError):',
		'            continue',
		'        module_matches = any(arguments[index:index + 2] == ["-m", module_name] for index in range(max(0, len(arguments) - 1)))',
		'        socket_matches = any(arguments[index:index + 2] == ["--socket", socket_path] for index in range(max(0, len(arguments) - 1)))',
		'        if module_matches and socket_matches:',
		'            matches.append(int(process_path.name))',
		'    if len(matches) != 1:',
		'        raise RuntimeError(f"expected exactly one invocation relay process, found {len(matches)}")',
		'    os.kill(matches[0], signal.SIGTERM)',
		'    return matches[0]',
		'',
		'async def prove_forged_guest_envelope_isolated():',
		'    reader, writer = await asyncio.open_unix_connection(os.environ["AGENT_VM_TOOL_PORTAL_SOCKET"])',
		'    decoder = PortalRelayDecoder()',
		'    try:',
		'        writer.write(encode_relay_frame({"kind": "hello", "version": 1}))',
		'        await writer.drain()',
		'        ready = await read_relay_message(reader, decoder)',
		'        if ready is None or ready["kind"] != "ready" or ready["version"] != 1:',
		'            raise RuntimeError("raw guest connection did not complete the real relay handshake")',
		`        forged = json.loads(${JSON.stringify(JSON.stringify(forgedRequest))})`,
		'        writer.write(encode_unvalidated_relay_frame(forged))',
		'        await writer.drain()',
		'        if await read_relay_message(reader, decoder) is not None:',
		'            raise RuntimeError("forged guest envelope was not rejected by closing its connection")',
		'    finally:',
		'        writer.close()',
		'        try:',
		'            await writer.wait_closed()',
		'        except (BrokenPipeError, ConnectionResetError):',
		'            pass',
		'',
		'async def main() -> None:',
		`    host_sentinel_path = ${JSON.stringify(options.hostSentinelPath)}`,
		'    if os.path.exists(host_sentinel_path):',
		'        raise RuntimeError("execute_code composition unexpectedly ran on the controller host")',
		'    interpreter_path = pathlib.PurePosixPath(sys.executable)',
		'    if interpreter_path.parent != pathlib.PurePosixPath("/opt/agent-vm-tools/bin") or re.fullmatch(r"python(?:3(?:\\.\\d+)?)?", interpreter_path.name) is None:',
		'        raise RuntimeError("execute_code did not use the managed Tool VM interpreter")',
		'    if re.fullmatch(r"/tmp/hermes_exec_[0-9a-f]{12}", os.getcwd()) is None:',
		'        raise RuntimeError("execute_code did not use the stock remote sandbox directory")',
		'    origin_path = pathlib.Path("/workspace/portal-composition-tool-vm-origin.json")',
		'    origin_path.write_text(json.dumps({"cwd": os.getcwd(), "hostSentinelVisible": False, "interpreter": sys.executable}, sort_keys=True), encoding="utf-8")',
		`    expected_artifact_bytes = bytes(range(256)) * 3840`,
		`    if len(expected_artifact_bytes) != ${String(artifactPayloadByteLength)}: raise RuntimeError("artifact fixture length is incorrect")`,
		'    expected_artifact_sha256 = hashlib.sha256(expected_artifact_bytes).hexdigest()',
		`    pathlib.Path("/work/${artifactPayloadRelativePath}").write_bytes(expected_artifact_bytes)`,
		'    async with connect_tool_portal() as portal:',
		`        search_result = await portal.search(json.loads(${JSON.stringify(JSON.stringify(pythonSearchRequest))}))`,
		'        search_payload = search_result.model_dump(by_alias=True, mode="json", exclude_none=True)',
		'        if not search_payload["ok"] or len(search_payload["items"]) != 1 or search_payload["items"][0]["status"] != "ok":',
		'            raise RuntimeError("Python SDK search did not return one successful canonical item")',
		`        if ${JSON.stringify(fakeUpstreamNamespace)} not in [entry["namespace"] for entry in search_payload["items"][0]["value"]["namespaceDiscovery"]]:`,
		'            raise RuntimeError("Python SDK search omitted the deterministic MCP namespace")',
		`        if not any(tool["namespace"] == ${JSON.stringify(fakeUpstreamNamespace)} and tool["name"] == "read_thing" for tool in search_payload["items"][0]["value"]["tools"]):`,
		'            raise RuntimeError("Python SDK search query did not return the expected summary match")',
		`        first_result = await portal.call(json.loads(${JSON.stringify(JSON.stringify({ calls: [{ arguments: { title: 'python-seed' }, id: 'python-mcp-read', name: 'read_thing', namespace: fakeUpstreamNamespace }] }))}))`,
		'        first_payload = first_result.model_dump(by_alias=True, mode="json", exclude_none=True)',
		'        if not first_payload["ok"] or len(first_payload["items"]) != 1 or first_payload["items"][0]["status"] != "ok":',
		'            raise RuntimeError("Python SDK MCP call did not return one successful canonical item")',
		'        returned_tool_name = first_payload["items"][0]["value"]["result"]["structuredContent"]["name"]',
		'        if returned_tool_name != "read_thing": raise RuntimeError("Python SDK MCP result payload did not identify read_thing")',
		'        derived_value = "derived-from-" + returned_tool_name.replace("_", "-")',
		`        if derived_value != ${JSON.stringify(resultDerivedValue)}: raise RuntimeError("Python SDK derived an unexpected downstream value")`,
		`        hidden_result = await portal.call(json.loads(${JSON.stringify(JSON.stringify({ calls: [{ arguments: { argv: ['write-hidden-effect'], reason: 'Verify hidden capability denial' }, id: 'python-hidden-host', name: hiddenHostEffectOperationName, namespace: configuredCliNamespace }] }))}))`,
		'        hidden_payload = hidden_result.model_dump(by_alias=True, mode="json", exclude_none=True)',
		'        if hidden_payload["ok"] or len(hidden_payload["items"]) != 1: raise RuntimeError("hidden host capability did not return one canonical failure")',
		'        hidden_item = hidden_payload["items"][0]',
		'        if hidden_item["status"] != "error" or hidden_item["error"]["code"] != "capability_denied" or hidden_item["outcome"] != {"certainty": "proven", "kind": "not-dispatched", "retryClass": "safe-before-dispatch"}: raise RuntimeError("hidden host capability did not retain canonical non-dispatch semantics")',
		'        await prove_forged_guest_envelope_isolated()',
		`        post_misuse_result = await portal.search(json.loads(${JSON.stringify(JSON.stringify({ requests: [{ id: 'post-misuse-search', limit: 5, query: 'read', schemaDetail: 'summary' }] }))}))`,
		'        post_misuse_payload = post_misuse_result.model_dump(by_alias=True, mode="json", exclude_none=True)',
		'        if not post_misuse_payload["ok"] or post_misuse_payload["items"][0]["status"] != "ok": raise RuntimeError("normal SDK channel did not survive forged peer rejection")',
		`        artifact_call = await portal.call(json.loads(${JSON.stringify(JSON.stringify({ calls: [{ arguments: { path: artifactPayloadRelativePath }, id: 'python-artifact-source', name: portalCompositionArtifactOperationName, namespace: portalCompositionArtifactNamespace }] }))}))`,
		'        artifact_call_payload = artifact_call.model_dump(by_alias=True, mode="json", exclude_none=True)',
		'        if not artifact_call_payload["ok"] or len(artifact_call_payload["items"]) != 1 or artifact_call_payload["items"][0]["status"] != "ok": raise RuntimeError("filesystem.read did not return one successful artifact item")',
		'        artifact_item = artifact_call_payload["items"][0]',
		`        if artifact_item["value"] != {"byteLength": ${String(artifactPayloadByteLength)}, "kind": "file"} or len(artifact_item.get("artifacts", [])) != 1: raise RuntimeError("filesystem.read did not return the expected artifact reference")`,
		'        artifact_reference = artifact_item["artifacts"][0]',
		`        python_artifact_read = await portal.artifacts.read({"maxBytes": ${String(artifactReadMaximumBytes)}, "offsetBytes": 0, "reference": artifact_reference})`,
		'        python_artifact_proof = verify_artifact_read(python_artifact_read.model_dump(by_alias=True, mode="json", exclude_none=True), artifact_reference, expected_artifact_bytes, expected_artifact_sha256)',
		`    node_program = ${JSON.stringify(nodeProgram)}`,
		'    child_environment = {**os.environ, "PORTAL_COMPOSITION_DERIVED_VALUE": derived_value, "PORTAL_COMPOSITION_ARTIFACT_REFERENCE": json.dumps(artifact_reference, separators=(",", ":"), sort_keys=True), "PORTAL_COMPOSITION_ARTIFACT_SHA256": expected_artifact_sha256}',
		'    node_result = subprocess.run(["node", "--input-type=module", "--eval", node_program], check=False, capture_output=True, text=True, env=child_environment)',
		'    if node_result.returncode != 0: raise RuntimeError("Node composition failed: " + node_result.stdout + " stderr: " + node_result.stderr)',
		'    node_payload = json.loads(node_result.stdout)',
		'    if derived_value not in node_result.stdout or "node-host-write" not in node_result.stdout: raise RuntimeError("Node SDK did not return both result-dependent Portal calls")',
		'    if node_payload["completionOrder"][0] != "fast" or node_payload["completionOrder"].index("slow") <= node_payload["completionOrder"].index("fast"): raise RuntimeError("Node SDK did not observe deliberately reversed independent responses")',
		`    if node_payload["artifact"] != {"byteLength": ${String(artifactPayloadByteLength)}, "sha256": expected_artifact_sha256}: raise RuntimeError("Node SDK artifact proof was not compact and exact")`,
		'    cli_write_request = json.dumps({"calls": [{"arguments": {"argv": ["write-credentialed-effect", derived_value], "reason": "Hermes composition E2E"}, "id": "cli-credentialed-write", "name": "credentialed_effect", "namespace": "portal_composition_execution"}]})',
		'    cli_write_result = subprocess.run(["tool-portal", "call", "--input-json", cli_write_request], check=False, capture_output=True, text=True)',
		'    if cli_write_result.returncode != 0 or "credentialed-runtime-effect-written" not in cli_write_result.stdout: raise RuntimeError("Credentialed CLI write failed: " + cli_write_result.stdout + " stderr: " + cli_write_result.stderr)',
		'    cli_read_request = json.dumps({"calls": [{"arguments": {"argv": ["read-credentialed-effect"], "reason": "Verify the Hermes composition E2E remote effect"}, "id": "cli-credentialed-read", "name": "credentialed_effect", "namespace": "portal_composition_execution"}]})',
		'    cli_read_result = subprocess.run(["tool-portal", "call", "--input-json", cli_read_request], check=False, capture_output=True, text=True)',
		'    if cli_read_result.returncode != 0 or derived_value not in cli_read_result.stdout or "credentialed-runtime-effect-read" not in cli_read_result.stdout: raise RuntimeError("Credentialed CLI read failed: " + cli_read_result.stdout + " stderr: " + cli_read_result.stderr)',
		`    cli_denied_request = ${JSON.stringify(JSON.stringify({ calls: [{ arguments: { argv: ['write-hidden-effect'], reason: 'Verify CLI denial exit class' }, id: 'cli-hidden-host', name: hiddenHostEffectOperationName, namespace: configuredCliNamespace }] }))}`,
		'    cli_denied = subprocess.run(["tool-portal", "call", "--input-json", cli_denied_request], check=False, capture_output=True, text=True, timeout=30)',
		'    if cli_denied.returncode != 1: raise RuntimeError("Managed CLI denial did not exit 1")',
		'    cli_denied_payload = json.loads(cli_denied.stdout)',
		'    if cli_denied_payload["ok"] or cli_denied_payload["items"][0]["error"]["code"] != "capability_denied": raise RuntimeError("Managed CLI denial did not preserve canonical JSON")',
		'    no_context_environment = dict(os.environ)',
		'    no_context_environment.pop("AGENT_VM_TOOL_PORTAL_SOCKET", None)',
		'    cli_unavailable = subprocess.run(["tool-portal", "call", "--input-json", cli_denied_request], check=False, capture_output=True, text=True, env=no_context_environment, timeout=30)',
		'    if cli_unavailable.returncode != 2 or cli_unavailable.stdout.strip() or not cli_unavailable.stderr.strip(): raise RuntimeError("Managed CLI unavailable context did not preserve exit 2 and stderr-only diagnostics")',
		`    cli_artifact_request = json.dumps({"maxBytes": ${String(artifactReadMaximumBytes)}, "offsetBytes": 0, "reference": artifact_reference}, separators=(",", ":"), sort_keys=True)`,
		'    cli_artifact_result = subprocess.run(["tool-portal", "artifact-read", "--input-json", cli_artifact_request], check=False, capture_output=True, text=True)',
		'    if cli_artifact_result.returncode != 0: raise RuntimeError("CLI artifact read failed: " + cli_artifact_result.stderr)',
		'    cli_artifact_proof = verify_artifact_read(json.loads(cli_artifact_result.stdout), artifact_reference, expected_artifact_bytes, expected_artifact_sha256)',
		'    loss_portal = connect_tool_portal()',
		'    await loss_portal.connect()',
		`    loss_prepare = await loss_portal.call({"calls": [{"arguments": {"argv": ["prepare-loss-probe"], "reason": "Prepare invocation relay loss probe"}, "id": "loss-prepare", "name": "${portalCompositionLossProbeOperationName}", "namespace": "${configuredCliNamespace}"}]})`,
		'    if not loss_prepare.model_dump(by_alias=True, mode="json")["ok"]: raise RuntimeError("loss probe preparation failed")',
		`    loss_slow_task = asyncio.create_task(loss_portal.call({"calls": [{"arguments": {"argv": ["wait-loss-slow", derived_value], "reason": "Hold admitted effect across relay loss", "timeoutMs": ${String(portalCompositionLossNaturalTimeoutMilliseconds)}}, "id": "loss-slow", "name": "${portalCompositionLossProbeOperationName}", "namespace": "${configuredCliNamespace}"}]}))`,
		`    loss_fast = await loss_portal.call({"calls": [{"arguments": {"argv": ["return-loss-fast", derived_value], "reason": "Confirm slow effect admission before relay loss"}, "id": "loss-fast", "name": "${portalCompositionLossProbeOperationName}", "namespace": "${configuredCliNamespace}"}]})`,
		'    if not loss_fast.model_dump(by_alias=True, mode="json")["ok"]: raise RuntimeError("loss probe fast admission evidence failed")',
		'    relay_pid = terminate_exact_invocation_relay()',
		'    try:',
		'        await loss_slow_task',
		'    except PortalConnectionUnavailableError as error:',
		'        if "uncertain" not in str(error): raise RuntimeError("relay loss did not retain transport uncertainty") from error',
		'    else:',
		'        raise RuntimeError("pending loss-probe call returned success or canonical non-dispatch after relay termination")',
		'    try:',
		'        await loss_portal.close()',
		'    except (PortalConnectionUnavailableError, BrokenPipeError, ConnectionResetError):',
		'        pass',
		'    reconnect = connect_tool_portal()',
		'    try:',
		'        await reconnect.connect()',
		'    except PortalConnectionUnavailableError:',
		'        reattach_rejected = True',
		'    else:',
		'        await reconnect.close()',
		'        raise RuntimeError("terminated invocation relay automatically reattached on the same endpoint")',
		'    print(json.dumps({"marker": "portal-composition-program-complete", "artifact": {"python": python_artifact_proof, "node": node_payload["artifact"], "cli": cli_artifact_proof}, "loss": {"pendingOutcome": "transport-uncertain", "reattachRejected": reattach_rejected, "relayPidObserved": relay_pid > 0}, "derivedValue": derived_value, "hostSentinelVisible": False, "hiddenDenial": hidden_payload, "node": node_payload, "origin": json.loads(origin_path.read_text(encoding="utf-8")), "python": first_payload, "postMisuse": post_misuse_payload, "cliRead": json.loads(cli_read_result.stdout), "cliWrite": json.loads(cli_write_result.stdout)}, sort_keys=True))',
		'',
		'asyncio.run(main())',
	].join('\n');
	return { nodeProgram, pythonProgram };
}

async function checkSyntax(options: {
	readonly arguments: readonly string[];
	readonly command: string;
	readonly label: string;
	readonly source: string;
}): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(options.command, options.arguments, {
			stdio: ['pipe', 'pipe', 'pipe'],
			signal: AbortSignal.timeout(10_000),
		});
		const stderr: Buffer[] = [];
		child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
		child.once('error', reject);
		child.once('close', (exitCode) => {
			if (exitCode === 0) resolve();
			else
				reject(
					new Error(
						`${options.label} syntax check failed: ${Buffer.concat(stderr).toString('utf8')}`,
					),
				);
		});
		child.stdin.end(options.source);
	});
}

export async function validatePortalCompositionGeneratedProgramSyntax(
	program: PortalCompositionGeneratedProgram,
): Promise<void> {
	await Promise.all([
		checkSyntax({
			arguments: [
				'--no-cache',
				'run',
				'--no-sync',
				'python',
				'-c',
				'import sys; compile(sys.stdin.read(), "portal-composition", "exec")',
			],
			command: 'uv',
			label: 'Python composition',
			source: program.pythonProgram,
		}),
		checkSyntax({
			arguments: ['--input-type=module', '--check'],
			command: process.execPath,
			label: 'Node composition',
			source: program.nodeProgram,
		}),
	]);
}
