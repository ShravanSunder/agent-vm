#!/usr/bin/env bash
set -euo pipefail

readonly HERMES_RUNTIME_IMAGE='docker.io/nousresearch/hermes-agent@sha256:16788311e2fa3035456bdc1bafb8ec2b1777db64ebf020af9bb7eb73c3712c9e'
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
		uv pip install \
			--python /opt/hermes/.venv/bin/python \
			pytest \
			ty \
			/workspace/python/agent-vm-agent-portal-sdk \
			/workspace/python/agent-vm-hermes-adapter
		/opt/hermes/.venv/bin/python -c '\''
import importlib.metadata as metadata
import pathlib
import tomllib

repository_root = pathlib.Path("/workspace")
sdk_project = tomllib.loads(
	(repository_root / "python/agent-vm-agent-portal-sdk/pyproject.toml").read_text()
)
adapter_project = tomllib.loads(
	(repository_root / "python/agent-vm-hermes-adapter/pyproject.toml").read_text()
)

assert metadata.version("hermes-agent") == "0.20.0"
assert metadata.version("agent-vm-agent-portal-sdk") == sdk_project["project"]["version"]
assert metadata.version("agent-vm-hermes-adapter") == adapter_project["project"]["version"]
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
