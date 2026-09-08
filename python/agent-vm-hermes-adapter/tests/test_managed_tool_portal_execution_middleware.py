import asyncio
import threading
import typing as t
import unittest
from collections.abc import Awaitable, Callable, Mapping
from unittest.mock import patch

from agent_vm_agent_portal_sdk.gateway_portal_session import GatewayPortalSessionConfig
from agent_vm_agent_portal_sdk.gateway_runtime_client import GatewayRuntimeClient
from pydantic import BaseModel, ConfigDict

from agent_vm_hermes_adapter.managed_profile_adapter import (
    CanonicalManagedAgentProjection,
    ManagedFrameworkIdentity,
)
from agent_vm_hermes_adapter.managed_tool_portal.execution_middleware import (
    HermesPortalInvocationScope,
    HermesToolExecutionMiddleware,
    current_hermes_portal_invocation_scope,
)


class _PortableResult(BaseModel):
    model_config = ConfigDict(extra="allow")


def _projection(*, agent_id: str = "agent-a") -> CanonicalManagedAgentProjection:
    return CanonicalManagedAgentProjection(
        agent_id=agent_id,
        framework_identity=ManagedFrameworkIdentity(kind="hermes", profile_name=agent_id),
        profile_assignment_revision=f"revision-{agent_id}",
        tool_portal_namespaces=(),
        tool_portal_profile_id=f"portal-{agent_id}",
    )


class _ApprovalPresenter:
    async def present(self, session_id: str, request: BaseModel) -> BaseModel:
        del session_id, request
        return _PortableResult()


class _RuntimeAdapter:
    def run_gateway_runtime_coroutine[TResult](
        self,
        coroutine: t.Coroutine[object, object, TResult],
        *,
        timeout: float | None = None,
    ) -> TResult:
        del timeout
        return asyncio.run(coroutine)


class _GatewayRuntimeClientStub(GatewayRuntimeClient):
    def __init__(self) -> None:
        pass


class _MiddlewareRuntime:
    def __init__(self) -> None:
        self.adapter = _RuntimeAdapter()
        self.approval_presenter = _ApprovalPresenter()
        self.selected_projection = _projection()

    def current_projection(self) -> CanonicalManagedAgentProjection:
        return self.selected_projection


class _PortalSession:
    created: list["_PortalSession"] = []
    open_gate: asyncio.Event | None = None

    def __init__(
        self,
        *,
        client: object,
        config: GatewayPortalSessionConfig,
        present_approval: Callable[[BaseModel], Awaitable[BaseModel]],
    ) -> None:
        del client, present_approval
        self.config = config
        self.socket_path = f"/tmp/socket-{len(self.created)}"
        self.open_calls = 0
        self.close_calls = 0
        self.created.append(self)

    async def open(self) -> None:
        self.open_calls += 1
        if self.open_gate is not None:
            await self.open_gate.wait()

    async def close(self) -> None:
        self.close_calls += 1


@t.final
class HermesToolExecutionMiddlewareTests(unittest.TestCase):
    def test_captures_exact_identity_and_calls_stock_continuation_once(self) -> None:
        runtime = _MiddlewareRuntime()
        middleware = HermesToolExecutionMiddleware(runtime)
        captured_scopes: list[HermesPortalInvocationScope] = []
        continuation_calls: list[dict[str, object]] = []

        def continue_execution(args: dict[str, object]) -> str:
            continuation_calls.append(args)
            scope = current_hermes_portal_invocation_scope()
            if scope is None:
                self.fail("eligible execution did not receive its Portal invocation scope")
            captured_scopes.append(scope)
            self.assertEqual(scope.identity.session_id, "session-a")
            self.assertEqual(scope.identity.turn_id, "turn-a")
            self.assertEqual(scope.identity.tool_call_id, "call-a")
            self.assertEqual(scope.identity.task_id, "task-a")
            self.assertEqual(scope.identity.api_request_id, "request-a")
            self.assertIs(scope.identity.projection, runtime.selected_projection)
            return "stock-result"

        result = middleware(
            tool_name="execute_code",
            args={"code": "print('ready')"},
            original_args={"code": "print('ready')"},
            task_id="task-a",
            session_id="session-a",
            tool_call_id="call-a",
            turn_id="turn-a",
            api_request_id="request-a",
            telemetry_schema_version="hermes.observer.v1",
            middleware_schema_version="hermes.middleware.v1",
            next_call=continue_execution,
        )

        self.assertEqual(result, "stock-result")
        self.assertEqual(len(continuation_calls), 1)
        self.assertEqual(len(captured_scopes), 1)
        self.assertIsNone(current_hermes_portal_invocation_scope())

    def test_foreground_terminal_reuses_outer_scope_but_background_and_missing_session_do_not(
        self,
    ) -> None:
        runtime = _MiddlewareRuntime()
        middleware = HermesToolExecutionMiddleware(runtime)
        seen_scopes: list[HermesPortalInvocationScope | None] = []

        def run_nested(args: dict[str, object]) -> str:
            del args
            outer_scope = current_hermes_portal_invocation_scope()
            seen_scopes.append(outer_scope)
            nested_result = middleware(
                tool_name="terminal",
                args={"command": "printf nested"},
                original_args={"command": "printf nested"},
                task_id="task-a",
                session_id="session-a",
                tool_call_id="call-nested",
                turn_id="turn-a",
                api_request_id="request-a",
                telemetry_schema_version="hermes.observer.v1",
                middleware_schema_version="hermes.middleware.v1",
                next_call=lambda nested_args: (
                    seen_scopes.append(current_hermes_portal_invocation_scope())
                    or str(nested_args["command"])
                ),
            )
            self.assertEqual(nested_result, "printf nested")
            return "outer-result"

        self.assertEqual(
            middleware(
                tool_name="execute_code",
                args={"code": "pass"},
                original_args={"code": "pass"},
                task_id="task-a",
                session_id="session-a",
                tool_call_id="call-outer",
                turn_id="turn-a",
                api_request_id="request-a",
                telemetry_schema_version="hermes.observer.v1",
                middleware_schema_version="hermes.middleware.v1",
                next_call=run_nested,
            ),
            "outer-result",
        )
        self.assertIs(seen_scopes[0], seen_scopes[1])

        for tool_name, args, session_id in (
            ("terminal", {"command": "server", "background": True}, "session-a"),
            ("terminal", {"command": "printf foreground"}, ""),
        ):
            with self.subTest(tool_name=tool_name, args=args, session_id=session_id):
                observed: list[HermesPortalInvocationScope | None] = []
                invocation_args: dict[str, object] = dict(args)
                middleware(
                    tool_name=tool_name,
                    args=invocation_args,
                    original_args=invocation_args,
                    task_id="task-a",
                    session_id=session_id,
                    tool_call_id="call-a",
                    turn_id="turn-a",
                    api_request_id="request-a",
                    telemetry_schema_version="hermes.observer.v1",
                    middleware_schema_version="hermes.middleware.v1",
                    next_call=lambda next_args: (
                        observed.append(current_hermes_portal_invocation_scope()) or next_args
                    ),
                )
                self.assertEqual(observed, [None])

    def test_optional_correlation_ids_do_not_disable_a_real_session_scope(self) -> None:
        runtime = _MiddlewareRuntime()
        middleware = HermesToolExecutionMiddleware(runtime)
        captured: list[HermesPortalInvocationScope | None] = []

        result = middleware(
            tool_name="terminal",
            args={"command": "printf scoped", "timeout": 300},
            original_args={"command": "printf scoped", "timeout": 300},
            task_id="",
            session_id="session-a",
            tool_call_id="",
            turn_id="",
            api_request_id="",
            telemetry_schema_version="hermes.observer.v1",
            middleware_schema_version="hermes.middleware.v1",
            next_call=lambda args: (
                captured.append(current_hermes_portal_invocation_scope()) or args
            ),
        )

        if not isinstance(result, Mapping):
            self.fail("stock continuation did not return its argument mapping")
        self.assertEqual(result["command"], "printf scoped")
        scope = captured[0]
        if scope is None:
            self.fail("real session was disabled by absent optional correlation")
        self.assertIsNone(scope.identity.task_id)
        self.assertIsNone(scope.identity.tool_call_id)
        self.assertIsNone(scope.identity.turn_id)
        self.assertIsNone(scope.identity.api_request_id)

    def test_concurrent_conversations_keep_independent_immutable_scopes(self) -> None:
        runtime = _MiddlewareRuntime()
        middleware = HermesToolExecutionMiddleware(runtime)
        continuation_barrier = threading.Barrier(2)
        captured_scopes: dict[str, HermesPortalInvocationScope] = {}
        worker_errors: list[BaseException] = []

        def invoke_conversation(session_id: str) -> None:
            def continue_execution(args: dict[str, object]) -> str:
                del args
                scope = current_hermes_portal_invocation_scope()
                if scope is None:
                    raise AssertionError("concurrent invocation omitted its scope")
                captured_scopes[session_id] = scope
                continuation_barrier.wait(timeout=2)
                return session_id

            try:
                result = middleware(
                    tool_name="execute_code",
                    args={"code": "pass"},
                    original_args={"code": "pass"},
                    task_id=f"task-{session_id}",
                    session_id=session_id,
                    tool_call_id=f"call-{session_id}",
                    turn_id=f"turn-{session_id}",
                    api_request_id=f"request-{session_id}",
                    telemetry_schema_version="hermes.observer.v1",
                    middleware_schema_version="hermes.middleware.v1",
                    next_call=continue_execution,
                )
                self.assertEqual(result, session_id)
            except BaseException as error:
                worker_errors.append(error)

        threads = [
            threading.Thread(target=invoke_conversation, args=(session_id,))
            for session_id in ("session-a", "session-b")
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(worker_errors, [])
        self.assertEqual(set(captured_scopes), {"session-a", "session-b"})
        self.assertIsNot(captured_scopes["session-a"], captured_scopes["session-b"])
        self.assertEqual(captured_scopes["session-a"].identity.session_id, "session-a")
        self.assertEqual(captured_scopes["session-b"].identity.session_id, "session-b")

    def test_session_open_is_single_flight_per_environment_generation_and_close_cleans_all(
        self,
    ) -> None:
        async def scenario() -> None:
            _PortalSession.created.clear()
            identity = HermesToolExecutionMiddleware(_MiddlewareRuntime()).build_identity(
                task_id="task-a",
                session_id="session-a",
                tool_call_id="call-a",
                turn_id="turn-a",
                api_request_id="request-a",
                tool_name="terminal",
                args={"command": "printf ready", "timeout": 120},
            )
            if identity is None:
                self.fail("complete invocation identity was rejected")
            scope = HermesPortalInvocationScope(
                identity=identity,
                present_approval=lambda request: _ApprovalPresenter().present(
                    identity.session_id,
                    request,
                ),
                session_factory=_PortalSession,
            )
            client = _GatewayRuntimeClientStub()
            first_config = GatewayPortalSessionConfig(
                environment={"owningGeneration": "generation-a"},
                sandbox_context={"principal": {"agentId": "agent-a"}},
                portal_context={"principal": {"agentId": "agent-a"}},
                maximum_runtime_ms=120_000,
            )
            first, second = await asyncio.gather(
                scope.socket_path_for_environment(
                    client=client,
                    owning_generation="generation-a",
                    config=first_config,
                ),
                scope.socket_path_for_environment(
                    client=client,
                    owning_generation="generation-a",
                    config=first_config,
                ),
            )
            third = await scope.socket_path_for_environment(
                client=client,
                owning_generation="generation-b",
                config=first_config.model_copy(
                    update={"environment": {"owningGeneration": "generation-b"}}
                ),
            )

            self.assertEqual(first, second)
            self.assertNotEqual(first, third)
            self.assertEqual(len(_PortalSession.created), 2)
            self.assertEqual([session.open_calls for session in _PortalSession.created], [1, 1])

            await scope.close()

            self.assertEqual([session.close_calls for session in _PortalSession.created], [1, 1])

        asyncio.run(scenario())

    def test_close_cancels_an_opening_session_and_never_creates_a_successor(self) -> None:
        async def scenario() -> None:
            _PortalSession.created.clear()
            _PortalSession.open_gate = asyncio.Event()
            runtime = _MiddlewareRuntime()
            identity = HermesToolExecutionMiddleware(runtime).build_identity(
                task_id="task-a",
                session_id="session-a",
                tool_call_id="call-a",
                turn_id="turn-a",
                api_request_id="request-a",
                tool_name="terminal",
                args={"command": "printf ready", "timeout": 120},
            )
            if identity is None:
                self.fail("complete invocation identity was rejected")
            scope = HermesPortalInvocationScope(
                identity=identity,
                present_approval=lambda request: runtime.approval_presenter.present(
                    identity.session_id,
                    request,
                ),
                session_factory=_PortalSession,
            )
            client = _GatewayRuntimeClientStub()
            config = GatewayPortalSessionConfig(
                environment={"owningGeneration": "generation-a"},
                sandbox_context={},
                portal_context={},
                maximum_runtime_ms=120_000,
            )
            opening = asyncio.create_task(
                scope.socket_path_for_environment(
                    client=client,
                    owning_generation="generation-a",
                    config=config,
                )
            )
            while not _PortalSession.created or _PortalSession.created[0].open_calls == 0:
                await asyncio.sleep(0)

            await scope.close()

            with self.assertRaises(asyncio.CancelledError):
                await opening
            self.assertEqual(_PortalSession.created[0].close_calls, 1)
            with self.assertRaisesRegex(RuntimeError, "ended"):
                await scope.socket_path_for_environment(
                    client=client,
                    owning_generation="generation-b",
                    config=config,
                )

        try:
            asyncio.run(scenario())
        finally:
            _PortalSession.open_gate = None

    def test_expired_scope_does_not_classify_deadline_as_relay_unavailability(self) -> None:
        runtime = _MiddlewareRuntime()
        identity = HermesToolExecutionMiddleware(runtime).build_identity(
            task_id="task-a",
            session_id="session-a",
            tool_call_id="call-a",
            turn_id="turn-a",
            api_request_id="request-a",
            tool_name="terminal",
            args={"command": "printf ready", "timeout": 120},
        )
        if identity is None:
            self.fail("complete invocation identity was rejected")
        expired_identity = identity.model_copy(update={"deadline_monotonic": 1.0})

        async def scenario() -> None:
            scope = HermesPortalInvocationScope(
                identity=expired_identity,
                present_approval=lambda request: runtime.approval_presenter.present(
                    identity.session_id,
                    request,
                ),
            )
            with self.assertRaisesRegex(RuntimeError, "deadline expired"):
                _ = scope.remaining_runtime_milliseconds()
            await scope.close()

        with patch(
            "agent_vm_hermes_adapter.managed_tool_portal.execution_middleware.monotonic",
            return_value=2.0,
        ):
            asyncio.run(scenario())

    def test_close_during_failed_open_cleanup_remains_cancellation_not_unavailability(self) -> None:
        async def scenario() -> None:
            cleanup_started = asyncio.Event()
            retain_cleanup = asyncio.Event()

            class FailedOpeningSession:
                socket_path = "/tmp/never-published/p.sock"

                def __init__(self, **session_arguments: object) -> None:
                    del session_arguments

                async def open(self) -> None:
                    raise RuntimeError("relay-open-failed")

                async def close(self) -> None:
                    cleanup_started.set()
                    await retain_cleanup.wait()

            runtime = _MiddlewareRuntime()
            identity = HermesToolExecutionMiddleware(runtime).build_identity(
                task_id="task-a",
                session_id="session-a",
                tool_call_id="call-a",
                turn_id="turn-a",
                api_request_id="request-a",
                tool_name="terminal",
                args={"command": "printf ready", "timeout": 120},
            )
            if identity is None:
                self.fail("complete invocation identity was rejected")
            scope = HermesPortalInvocationScope(
                identity=identity,
                present_approval=lambda request: runtime.approval_presenter.present(
                    identity.session_id,
                    request,
                ),
                session_factory=FailedOpeningSession,
            )
            config = GatewayPortalSessionConfig(
                environment={"owningGeneration": "generation-a"},
                sandbox_context={},
                portal_context={},
                maximum_runtime_ms=120_000,
            )
            opening = asyncio.create_task(
                scope.socket_path_for_environment(
                    client=_GatewayRuntimeClientStub(),
                    owning_generation="generation-a",
                    config=config,
                )
            )
            await cleanup_started.wait()

            await scope.close()

            with self.assertRaises(asyncio.CancelledError):
                await opening
            with self.assertRaisesRegex(RuntimeError, "ended"):
                await scope.socket_path_for_environment(
                    client=_GatewayRuntimeClientStub(),
                    owning_generation="generation-a",
                    config=config,
                )

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
