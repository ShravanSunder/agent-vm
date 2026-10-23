#!/usr/bin/env bash
set -euo pipefail

readonly HERMES_RUNTIME_IMAGE='docker.io/nousresearch/hermes-agent@sha256:fca358f12efd65bfaaca05884166f15c0e2788375ca30d77061ac1ebc96452b7'
readonly REPOSITORY_ROOT="$(git rev-parse --show-toplevel)"
readonly CHECK_KIND="${1:-test}"

if [[ "${CHECK_KIND}" != 'test' && "${CHECK_KIND}" != 'typecheck' ]]; then
	echo "Usage: $0 [test|typecheck]" >&2
	exit 2
fi

docker run --rm \
	--entrypoint /bin/bash \
	--mount "type=bind,source=${REPOSITORY_ROOT},target=/workspace,readonly" \
	--workdir /workspace \
	--env PYTHONDONTWRITEBYTECODE=1 \
	--env "AGENT_VM_HERMES_CHECK_KIND=${CHECK_KIND}" \
	"${HERMES_RUNTIME_IMAGE}" \
	-c '
		set -euo pipefail
		/opt/hermes/.venv/bin/python -c '\''
import importlib.metadata as metadata
import pathlib
import subprocess
import sys
import tomllib

repository_root = pathlib.Path("/workspace")
lockfile = tomllib.loads((repository_root / "uv.lock").read_text())
locked_tools = {}
for tool_name in ("pytest", "ty"):
	versions = [package["version"] for package in lockfile["package"] if package["name"] == tool_name]
	if len(versions) != 1 or not isinstance(versions[0], str):
		raise RuntimeError(f"Expected one locked version for {tool_name}")
	locked_tools[tool_name] = versions[0]
subprocess.run(
	[
		"uv", "pip", "install", "--python", sys.executable,
		*[f"{name}=={version}" for name, version in locked_tools.items()],
		str(repository_root / "python/agent-vm-agent-portal-sdk"),
		str(repository_root / "python/agent-vm-hermes-adapter"),
	],
	check=True,
)
for tool_name, locked_version in locked_tools.items():
	assert metadata.version(tool_name) == locked_version
	print(f"Hermes check tool: {tool_name}=={locked_version}", flush=True)

sdk_project = tomllib.loads(
	(repository_root / "python/agent-vm-agent-portal-sdk/pyproject.toml").read_text()
)
adapter_project = tomllib.loads(
	(repository_root / "python/agent-vm-hermes-adapter/pyproject.toml").read_text()
)

assert metadata.version("hermes-agent") == "0.21.5"
assert metadata.version("agent-vm-agent-portal-sdk") == sdk_project["project"]["version"]
assert metadata.version("agent-vm-hermes-adapter") == adapter_project["project"]["version"]
assert metadata.version("mcp") == "2.0.0"
assert metadata.version("httpx2").split(".")[0] == "2"
assert "mcp==2.0.0" in metadata.requires("agent-vm-agent-portal-sdk")
import agent_vm_agent_portal_sdk.standard_mcp_transport
'\''
		if [[ "${AGENT_VM_HERMES_CHECK_KIND}" == "test" ]]; then
			/opt/hermes/.venv/bin/python -m pytest \
				-p no:cacheprovider \
				/workspace/python/agent-vm-hermes-adapter
		else
			/opt/hermes/.venv/bin/ty check \
				--project /workspace/python/agent-vm-hermes-adapter \
				--config "environment.root = [\"/workspace/python/agent-vm-hermes-adapter/src\"]" \
				--extra-search-path /opt/hermes \
				--python /opt/hermes/.venv/bin/python \
				/workspace/python/agent-vm-hermes-adapter/src \
				/workspace/python/agent-vm-hermes-adapter/tests
		fi
	'
