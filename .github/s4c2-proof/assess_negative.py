"""Reject setup-only, timeout, unobserved mutation, or unintended-effect CI reds."""

import json
import pathlib
import sys

mode, status, log_path = sys.argv[1:]
log = pathlib.Path(log_path).read_text()
if status != "1":
    raise RuntimeError(f"Expected a Vitest assertion/runtime failure, got {status}; inconclusive")
if 's4c2-negative-image-input ' not in log:
    raise RuntimeError("The generated image mutation was never applied")


def records(prefix: str) -> list[dict[str, object]]:
    result = []
    for line in log.splitlines():
        if prefix in line:
            value = line.split(prefix, 1)[1]
            try:
                result.append(json.loads(value))
            except json.JSONDecodeError:
                continue
    return result


wires = records("s4c2-negative-wire ")
controller = records("s4c2-negative-controller-records ")
installed = records("s4c2-installed-readback ")
if not wires or not controller or not installed:
    raise RuntimeError("Missing real upstream or controller readback; inconclusive")
if any("write_thing" in entry.get("callNames", []) for entry in wires):
    raise RuntimeError("Negative build produced a write effect")
if any(entry.get("approvalRecordCount") != 0 for entry in controller):
    raise RuntimeError("Negative startup unexpectedly reached controller approval admission")
if mode == "wrong-mcp":
    methods = [method for entry in wires for method in entry.get("methods", [])]
    if not any(method in methods for method in ("server/discover", "tools/call")):
        raise RuntimeError("No real standard MCP wire request observed")
    stage = "private-handshake-attempt" if "tools/call" in methods else "modern-discovery-refused"
    inputs = records("s4c2-negative-image-input ")
    if not inputs or all(entry.get("clientSha256") == inputs[-1].get("originalClientSha256") for entry in installed):
        raise RuntimeError("Missing actual VM installed client mutation readback")
else:
    if not any("mcp<2" in str(entry.get("requiresDist")) and entry.get("standardSha256") == "2e12968d1fa58fe3576126d042c1533e5774431c14cfd64ab4d1e2aa7e7f7062" for entry in installed):
        raise RuntimeError("Actual old installed wheel metadata was not observed")
    stage = "stale-installed-wheel-runtime-or-provenance-refusal"
print(json.dumps({"mode": mode, "status": "negative-observed", "stage": stage, "writeEffects": 0, "approvalRecords": 0, "requiresManualDecidingAssertionReview": True}))
