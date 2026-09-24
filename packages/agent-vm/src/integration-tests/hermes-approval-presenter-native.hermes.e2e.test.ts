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
	'docker.io/nousresearch/hermes-agent@sha256:fca358f12efd65bfaaca05884166f15c0e2788375ca30d77061ac1ebc96452b7';

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

from aiohttp import ClientSession, web
from agent_vm_agent_portal_sdk.contracts import PORTABLE_CONTRACT_ADAPTERS
from agent_vm_hermes_adapter.managed_gateway_runtime_client_loop import GatewayRuntimeClientLoop
from agent_vm_hermes_adapter.managed_tool_portal.hermes_approval_presenter import (
    HermesGatewayApprovalPresenter,
    HermesGatewayApprovalRouteStore,
)
from gateway.config import PlatformConfig
from gateway.platforms.api_server import APIServerAdapter
from gateway.session_context import clear_session_vars, set_session_vars
from pydantic import BaseModel
from tools.approval import register_gateway_notify, unregister_gateway_notify
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
        return "routing-key-approval-e2e"


class SessionStore:
    def peek_session_id(self, session_key):
        return "session-approval-e2e" if session_key == "routing-key-approval-e2e" else None


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
        return routes.capture(
            gateway=gateway,
            session_store=SessionStore(),
            source=source_fixture,
        )

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

    api_requests = []
    api_request_ready = threading.Event()

    def notify_api_approval(approval_data):
        assert approval_data["description"].startswith("Approve files.write once?")
        api_requests.append(approval_data["description"])
        api_request_ready.set()

    register_gateway_notify("run-approval-e2e", notify_api_approval)
    portal_loop = GatewayRuntimeClientLoop(SimpleNamespace())
    try:
        async def exercise_http_approvals():
            api_adapter = APIServerAdapter(
                PlatformConfig(enabled=True, extra={"key": "local-test-key"})
            )
            api_adapter._run_statuses["run-approval-e2e"] = {"status": "running"}
            api_adapter._run_approval_sessions["run-approval-e2e"] = "run-approval-e2e"
            api_adapter._run_owners["run-approval-e2e"] = api_adapter._run_idempotency_scope(
                SimpleNamespace(headers={})
            )
            api_adapter._run_streams["run-approval-e2e"] = asyncio.Queue()
            app = web.Application()
            app.router.add_post(
                "/v1/runs/{run_id}/approval", api_adapter._handle_run_approval
            )
            runner = web.AppRunner(app)
            await runner.setup()
            site = web.TCPSite(runner, "127.0.0.1", 0)
            await site.start()
            assert site._server is not None
            port = site._server.sockets[0].getsockname()[1]
            outcomes = []
            http_choices = []
            wrong_key_statuses = []
            try:
                async with ClientSession() as client:
                    for challenge_id, choice in [
                        ("33333333-3333-4333-8333-333333333333", "once"),
                        ("44444444-4444-4444-8444-444444444444", "deny"),
                    ]:
                        api_request_ready.clear()
                        api_tokens = set_session_vars(
                            platform="api_server",
                            session_key="run-approval-e2e",
                            session_id="api-session-approval-e2e",
                            cron_session="",
                        )
                        try:
                            pending = portal_loop.submit(
                                presenter.present(
                                    "api-session-approval-e2e",
                                    presentation_request(challenge_id),
                                )
                            )
                        finally:
                            clear_session_vars(api_tokens)
                        assert await asyncio.to_thread(api_request_ready.wait, 5)
                        async with client.post(
                            f"http://127.0.0.1:{port}/v1/runs/run-approval-e2e/approval",
                            headers={"Authorization": "Bearer wrong-local-test-key"},
                            json={"choice": choice},
                        ) as response:
                            wrong_key_statuses.append(response.status)
                            assert (await response.json())["error"]["code"] == "gateway_auth_failed"
                        assert pending.done() is False
                        async with client.post(
                            f"http://127.0.0.1:{port}/v1/runs/run-approval-e2e/approval",
                            headers={"Authorization": "Bearer local-test-key"},
                            json={"choice": choice},
                        ) as response:
                            assert response.status == 200
                            http_choices.append((await response.json())["choice"])
                        outcome = await asyncio.wrap_future(pending)
                        outcomes.append(
                            outcome.model_dump(by_alias=True, exclude_none=True, mode="json")
                        )
            finally:
                await runner.cleanup()
            return outcomes, http_choices, wrong_key_statuses

        api_outcomes, api_http_choices, api_wrong_key_statuses = asyncio.run(
            exercise_http_approvals()
        )
    finally:
        portal_loop.close(disconnect=False)
        unregister_gateway_notify("run-approval-e2e")

    register("ordinary-clarify", "routing-key-approval-e2e", "ordinary", ["Continue"])
    routes.clear_by_session_id("session-approval-e2e")
    assert has_pending("routing-key-approval-e2e") is True
    assert resolve_gateway_clarify("ordinary-clarify", "Continue") is True
    assert wait_for_response("ordinary-clarify", 1) == "Continue"

    print(
        json.dumps(
            {
                "deniedOriginCaptured": denied_origin is not None,
                "interactions": adapter.interactions,
                "ordinaryClarifyPreserved": True,
                "outcomes": [approved_mapping, denied_mapping],
                "apiRequestCount": len(api_requests),
                "apiHttpChoices": api_http_choices,
                "apiOutcomes": api_outcomes,
                "apiWrongKeyStatuses": api_wrong_key_statuses,
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

describeHermesApprovalPresenterE2e('e2e: pinned Hermes approval presenter', () => {
	it('uses native clarify and authenticated HTTP run approval queues', async () => {
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
					sessionKey: 'routing-key-approval-e2e',
				},
				{
					clarifyId: 'gwappr-22222222-2222-4222-8222-222222222222',
					decision: 'Deny',
					sessionKey: 'routing-key-approval-e2e',
				},
			],
			ordinaryClarifyPreserved: true,
			outcomes: [{ kind: 'approved' }, { kind: 'denied' }],
			apiRequestCount: 2,
			apiHttpChoices: ['once', 'deny'],
			apiOutcomes: [{ kind: 'approved' }, { kind: 'denied' }],
			apiWrongKeyStatuses: [401, 401],
		});
	}, 180_000);
});
