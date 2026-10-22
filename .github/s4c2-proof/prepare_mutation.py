"""Render an exact scratch patch; apply/restore only in an approved disposable CI checkout."""

import argparse
import base64
import difflib
import hashlib
import json
import pathlib
import subprocess

TARGET = "83fac91a6dcb9ccd9a5fdf67cb6ff2b61ef05994"
TEST_PATH = "packages/agent-vm/src/integration-tests/portal-composition.hermes.e2e.test.ts"
CLIENT_PATH = "python/agent-vm-agent-portal-sdk/src/agent_vm_agent_portal_sdk/gateway_runtime_client.py"
OLD_WHEEL = "agent_vm_agent_portal_sdk-0.0.153-py3-none-any.whl"
OLD_HASH = "a9ba71fe6dc2c57dc3c93305e8820309627b5f85d3b01297d2c9417380ef5d15"

WRONG_TRANSPORT = '''
class S4c2WrongMcpTransport:
    def __init__(self):
        from pydantic import SecretStr
        from .standard_mcp_transport import StandardMcpToolPortalTransport, ToolPortalStreamableHttpMcpConfig
        self._mcp = StandardMcpToolPortalTransport(ToolPortalStreamableHttpMcpConfig(endpoint=__ENDPOINT__, authorization=SecretStr("s4c2-controlled-fixture")))

    async def connect(self, socket_path):
        print("s4c2-wrong-mcp-connect-attempt", flush=True)
        await self._mcp.connect()
        print("s4c2-wrong-mcp-connected", flush=True)

    async def handshake(self, attachment):
        # Never send real attachment material to the controlled MCP server.
        print("s4c2-wrong-mcp-private-handshake-request", flush=True)
        return await self._mcp.call_tool("managed-plugin.handshake", {})

    async def request(self, method, params):
        return await self._mcp.call_tool(method, {})

    async def disconnect(self):
        await self._mcp.close()
'''


def git(checkout: pathlib.Path, *arguments: str) -> str:
    return subprocess.check_output(["git", *arguments], cwd=checkout, text=True).strip()


def render(checkout: pathlib.Path, mode: str) -> tuple[str, str]:
    original = subprocess.check_output(["git", "show", f"{TARGET}:{TEST_PATH}"], cwd=checkout).decode()
    client_source = subprocess.check_output(["git", "show", f"{TARGET}:{CLIENT_PATH}"], cwd=checkout)
    client_hash = hashlib.sha256(client_source).hexdigest()
    if mode == "stale-wheel":
        recipe_lines = [
            f"COPY s4c2-stale/{OLD_WHEEL} /tmp/{OLD_WHEEL}",
            f"RUN uv pip install --no-deps --force-reinstall --python /opt/hermes/.venv/bin/python /tmp/{OLD_WHEEL}",
            "RUN /opt/hermes/.venv/bin/python -c 'import importlib.metadata as m,json; print(\"s4c2-stale-installed-requires\",json.dumps(m.requires(\"agent-vm-agent-portal-sdk\")))'",
        ]
        body = f'''
        const negativeFs = await import('node:fs/promises');
        const packet = process.env.S4C2_CI_PACKET_DIR;
        if (!packet) throw new Error('Missing approved CI packet directory');
        const negativeProfile = project.systemConfig.imageProfiles.gateways[zone.gateway.imageProfile];
        if (!negativeProfile) throw new Error('Missing selected Gateway profile');
        const context = path.dirname(negativeProfile.buildConfig);
        await negativeFs.mkdir(path.join(context, 's4c2-stale'), {{ recursive: true }});
        const staleBytes = await negativeFs.readFile(path.join(packet, {json.dumps(OLD_WHEEL)}));
        const digest = (await import('node:crypto')).createHash('sha256').update(staleBytes).digest('hex');
        if (digest !== {json.dumps(OLD_HASH)}) throw new Error('Unapproved stale wheel bytes');
        await negativeFs.writeFile(path.join(context, 's4c2-stale', {json.dumps(OLD_WHEEL)}), staleBytes);
        await negativeFs.appendFile(path.join(context, 'Dockerfile'), {json.dumps(chr(10) + chr(10).join(recipe_lines) + chr(10))});
        process.stdout.write('s4c2-negative-image-input ' + JSON.stringify({{ mode: 'stale-wheel', wheelOrigin: '83e9683f', wheelSha256: digest }}) + '\\n');
'''
    else:
        patch_python = f'''import hashlib,json,pathlib,sysconfig
module = pathlib.Path(sysconfig.get_paths()["purelib"]) / "agent_vm_agent_portal_sdk/gateway_runtime_client.py"
before = module.read_bytes()
assert hashlib.sha256(before).hexdigest() == {client_hash!r}, "wrong client artifact before mutation"
source = before.decode()
needle = "else GatewayRuntimeUdsTransport()"
assert source.count(needle) == 1
source = source.replace(needle, "else S4c2WrongMcpTransport()") + "\\n" + {WRONG_TRANSPORT!r}
compile(source, str(module), "exec")
module.write_text(source)
print("s4c2-wrong-installed-client", json.dumps({{"before": hashlib.sha256(before).hexdigest(), "after": hashlib.sha256(module.read_bytes()).hexdigest()}}))
'''
        body = f'''
        const negativeFs = await import('node:fs/promises');
        const negativeProfile = project.systemConfig.imageProfiles.gateways[zone.gateway.imageProfile];
        if (!negativeProfile) throw new Error('Missing selected Gateway profile');
        const endpoint = `http://${{fakeMcpHost}}:${{String(mcpServer.port)}}/mcp`;
        const patchPython = {json.dumps(patch_python)}.replace('__ENDPOINT__', JSON.stringify(endpoint));
        const encoded = Buffer.from(patchPython).toString('base64');
        const command = `RUN /opt/hermes/.venv/bin/python -c "import base64;exec(base64.b64decode('${{encoded}}'))"`;
        await negativeFs.appendFile(path.join(path.dirname(negativeProfile.buildConfig), 'Dockerfile'), '\\n' + command + '\\n');
        process.stdout.write('s4c2-negative-image-input ' + JSON.stringify({{ mode: 'wrong-mcp', originalClientSha256: {json.dumps(client_hash)} }}) + '\\n');
'''
    anchor = "\t\tawait prepareGatewayE2eProjectImages({ project });"
    assert original.count(anchor) == 1
    changed = original.replace(anchor, body + anchor)
    cleanup = "\t\tawait harness?.close({ preserveTempRoot: true });"
    assert changed.count(cleanup) == 1
    capture = '''
        process.stdout.write('s4c2-negative-wire ' + JSON.stringify({ methods: mcpServer?.requests.flatMap(request => request.jsonRpcMethods), callNames: mcpServer?.calls.map(call => call.name) }) + '\\n');
        if (project !== undefined) {
            const negativeRecords = resolveControllerGatewayRecordTargets({ gatewayStateRoot: resolveControllerGatewayStateRoot({ controllerStateRoot: createControllerStateRoot({ controllerStateDirectoryPath: project.systemConfig.controllerStateDir }), zoneId: project.zone.id }) }).approvalRecords;
            const negativeFs = await import('node:fs/promises');
            const recordNames = await negativeFs.readdir(negativeRecords.directoryPath).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
            process.stdout.write('s4c2-negative-controller-records ' + JSON.stringify({ approvalRecordCount: recordNames.filter(name => name.endsWith('.json')).length }) + '\\n');
        }
'''
    changed = changed.replace(cleanup, capture + cleanup)
    request_observer = "onControllerManagedVmCreateRequest: (request) => controllerManagedVmRequests.push(request),"
    assert changed.count(request_observer) == 1
    changed = changed.replace(request_observer, "onControllerManagedVmCreateRequest: (request) => { controllerManagedVmRequests.push(request); process.stdout.write('s4c2-actual-vm-image ' + JSON.stringify({ imageReference: request.imageReference, sessionLabel: request.sessionLabel }) + '\\n'); },")
    image_probe = '''import hashlib,importlib.metadata as metadata,json,pathlib,sysconfig
root=pathlib.Path(sysconfig.get_paths()["purelib"])/"agent_vm_agent_portal_sdk"
print(json.dumps({"requiresDist":metadata.requires("agent-vm-agent-portal-sdk"),"standardSha256":hashlib.sha256((root/"standard_mcp_transport.py").read_bytes()).hexdigest(),"clientSha256":hashlib.sha256((root/"gateway_runtime_client.py").read_bytes()).hexdigest()}))
'''
    vm_anchor = "\t\t\t\t\t\t\tgatewayVm = vm;"
    assert changed.count(vm_anchor) == 1
    vm_probe = f'''{vm_anchor}
                                const installedReadback = await vm.exec(['/opt/hermes/.venv/bin/python', '-I', '-c', {json.dumps(image_probe)}]);
                                process.stdout.write('s4c2-installed-readback ' + installedReadback.stdout.toString().trim() + '\\n');
'''
    changed = changed.replace(vm_anchor, vm_probe)
    return original, changed


parser = argparse.ArgumentParser()
parser.add_argument("action", choices=["render", "apply", "restore"])
parser.add_argument("--checkout", type=pathlib.Path, required=True)
parser.add_argument("--mode", choices=["stale-wheel", "wrong-mcp"], required=True)
parser.add_argument("--output", type=pathlib.Path, required=True)
parser.add_argument("--reference", required=True)
options = parser.parse_args()
if len(options.reference) != 40 or any(character not in "0123456789abcdef" for character in options.reference):
    raise RuntimeError("Supply the full approved lowercase commit SHA")
TARGET = options.reference
original, changed = render(options.checkout, options.mode)
options.output.mkdir(parents=True, exist_ok=True)
patch = ''.join(difflib.unified_diff(original.splitlines(True), changed.splitlines(True), fromfile=f"a/{TEST_PATH}", tofile=f"b/{TEST_PATH}"))
(options.output / f"{options.mode}.patch").write_text(patch)
(options.output / f"{options.mode}.rendered-source.txt").write_text(changed)
target_file = options.checkout / TEST_PATH
if options.action == "apply":
    if target_file.read_text() != original:
        raise RuntimeError("Refusing to overwrite a changed test; expected exact frozen bytes")
    if git(options.checkout, "status", "--porcelain", "--", TEST_PATH):
        raise RuntimeError("Target test is dirty")
    target_file.write_text(changed)
elif options.action == "restore":
    if target_file.read_text() != changed:
        raise RuntimeError("Refusing restoration over unexpected intervening edits")
    target_file.write_text(original)
print(json.dumps({"mode": options.mode, "action": options.action, "reference": TARGET, "originalSha256": hashlib.sha256(original.encode()).hexdigest(), "mutatedSha256": hashlib.sha256(changed.encode()).hexdigest(), "patchSha256": hashlib.sha256(patch.encode()).hexdigest()}))
