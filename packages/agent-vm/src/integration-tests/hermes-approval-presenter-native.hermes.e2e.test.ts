import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { currentE2eArchitecture } from './e2e-harness.js';
import { shouldRunHermesE2e } from './hermes-e2e-harness.js';

const execFileAsync = promisify(execFile);
const architecture = currentE2eArchitecture();
const runHermesApprovalPresenterE2e = await shouldRunHermesE2e({ architecture });
const describeHermesApprovalPresenterE2e = runHermesApprovalPresenterE2e ? describe : describe.skip;

const hermesRuntimeImage =
	'docker.io/nousresearch/hermes-agent@sha256:16788311e2fa3035456bdc1bafb8ec2b1777db64ebf020af9bb7eb73c3712c9e';

const pinnedPresenterProof = String.raw`
set -euo pipefail
uv pip install --quiet \
  --python /opt/hermes/.venv/bin/python \
  /workspace/python/agent-vm-agent-portal-sdk \
  /workspace/python/agent-vm-hermes-adapter
/opt/hermes/.venv/bin/python - <<'PY'
import asyncio
import json
import threading
from types import SimpleNamespace

from agent_vm_agent_portal_sdk.contracts import PORTABLE_CONTRACT_ADAPTERS
from agent_vm_hermes_adapter.managed_tool_portal.hermes_approval_presenter import (
    HermesGatewayApprovalPresenter,
    HermesGatewayApprovalRouteStore,
)
from pydantic import BaseModel
from tools.clarify_gateway import (
    has_pending,
    register,
    resolve_gateway_clarify,
    wait_for_response,
)


class Source:
    chat_id = "chat-approval-e2e"
    profile = "main"


class Adapter:
    def __init__(self) -> None:
        self.decisions = ["Approve", "Deny"]
        self.interactions = []

    async def send_clarify(
        self,
        chat_id,
        question,
        choices,
        clarify_id,
        session_key,
        metadata=None,
    ):
        assert chat_id == Source.chat_id
        assert choices == ["Approve", "Deny"]
        assert question.startswith("Approve files.write once?")
        assert metadata is None
        assert has_pending(session_key) is True
        decision = self.decisions.pop(0)
        assert resolve_gateway_clarify(clarify_id, decision) is True
        self.interactions.append(
            {
                "clarifyId": clarify_id,
                "decision": decision,
                "sessionKey": session_key,
            }
        )
        return SimpleNamespace(success=True)


class Gateway:
    def __init__(self, adapter, *, authorized) -> None:
        self.adapter = adapter
        self.authorized = authorized

    def _adapter_for_source(self, source):
        assert source is source_fixture
        return self.adapter

    def _is_user_authorized(self, source):
        assert source is source_fixture
        return self.authorized

    def _session_key_for_source(self, source):
        assert source is source_fixture
        return "session-approval-e2e"


def presentation_request(challenge_id):
    request = PORTABLE_CONTRACT_ADAPTERS[
        "gateway.approval.presentation-request"
    ].validate_python(
        {
            "allowedDecisions": ["approve", "deny"],
            "challengeId": challenge_id,
            "display": {"argumentsPreview": '{"path":"README.md"}'},
            "expiresAt": "2099-08-20T21:00:00.000Z",
            "itemId": challenge_id,
            "name": "write",
            "namespace": "files",
        }
    )
    assert isinstance(request, BaseModel)
    return request


source_fixture = Source()
adapter = Adapter()
routes = HermesGatewayApprovalRouteStore()
gateway_loop = asyncio.new_event_loop()
gateway_thread = threading.Thread(target=gateway_loop.run_forever)
gateway_thread.start()
try:
    async def capture(gateway):
        return routes.capture(gateway=gateway, source=source_fixture)

    denied_origin = asyncio.run_coroutine_threadsafe(
        capture(Gateway(adapter, authorized=False)), gateway_loop
    ).result(timeout=5)
    assert denied_origin is None
    admitted_origin = asyncio.run_coroutine_threadsafe(
        capture(Gateway(adapter, authorized=True)), gateway_loop
    ).result(timeout=5)
    assert admitted_origin is not None

    presenter = HermesGatewayApprovalPresenter(routes)
    approved = asyncio.run(
        presenter.present(
            "session-approval-e2e",
            presentation_request("11111111-1111-4111-8111-111111111111"),
        )
    )
    denied = asyncio.run(
        presenter.present(
            "session-approval-e2e",
            presentation_request("22222222-2222-4222-8222-222222222222"),
        )
    )
    approved_mapping = approved.model_dump(by_alias=True, exclude_none=True, mode="json")
    denied_mapping = denied.model_dump(by_alias=True, exclude_none=True, mode="json")

    register("ordinary-clarify", "session-approval-e2e", "ordinary", ["Continue"])
    routes.clear("session-approval-e2e")
    assert has_pending("session-approval-e2e") is True
    assert resolve_gateway_clarify("ordinary-clarify", "Continue") is True
    assert wait_for_response("ordinary-clarify", 1) == "Continue"

    print(
        json.dumps(
            {
                "deniedOriginCaptured": denied_origin is not None,
                "interactions": adapter.interactions,
                "ordinaryClarifyPreserved": True,
                "outcomes": [approved_mapping, denied_mapping],
            },
            sort_keys=True,
        )
    )
finally:
    gateway_loop.call_soon_threadsafe(gateway_loop.stop)
    gateway_thread.join(timeout=5)
    gateway_loop.close()
PY
`;

describeHermesApprovalPresenterE2e('e2e: pinned Hermes native approval presenter', () => {
	it('uses Hermes clarify ownership for exact approve and deny interactions', async () => {
		const repositoryRoot = process.cwd();
		const result = await execFileAsync(
			'docker',
			[
				'run',
				'--rm',
				'--entrypoint',
				'/bin/bash',
				'--mount',
				`type=bind,source=${repositoryRoot},target=/workspace,readonly`,
				'--workdir',
				'/workspace',
				hermesRuntimeImage,
				'-c',
				pinnedPresenterProof,
			],
			{ maxBuffer: 1_048_576, timeout: 120_000 },
		);
		const receipt = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as unknown;

		expect(receipt).toEqual({
			deniedOriginCaptured: false,
			interactions: [
				{
					clarifyId: 'gwappr-11111111-1111-4111-8111-111111111111',
					decision: 'Approve',
					sessionKey: 'session-approval-e2e',
				},
				{
					clarifyId: 'gwappr-22222222-2222-4222-8222-222222222222',
					decision: 'Deny',
					sessionKey: 'session-approval-e2e',
				},
			],
			ordinaryClarifyPreserved: true,
			outcomes: [{ kind: 'approved' }, { kind: 'denied' }],
		});
	}, 180_000);
});
