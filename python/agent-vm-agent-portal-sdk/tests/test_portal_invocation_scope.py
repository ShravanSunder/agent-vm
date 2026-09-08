import asyncio
from unittest.mock import patch

import pytest
from agent_vm_agent_portal_sdk.portal_invocation_scope import PortalInvocationScope, PortalScopeClosedError


def test_close_rejects_factory_before_it_can_create_work() -> None:
    async def scenario() -> None:
        scope = PortalInvocationScope()
        factory_calls: list[str] = []

        async def operation() -> str:
            return "unexpected"

        def factory() -> asyncio.Future[str]:
            factory_calls.append("called")
            return asyncio.ensure_future(operation())

        scope.close()
        with pytest.raises(PortalScopeClosedError):
            scope.admit(factory)
        assert factory_calls == []

    asyncio.run(scenario())


def test_close_cancels_admitted_work_without_waiting_for_a_late_response() -> None:
    async def scenario() -> None:
        scope = PortalInvocationScope()
        started = asyncio.Event()
        never_approved = asyncio.Event()
        effects: list[str] = []

        async def operation() -> None:
            started.set()
            await never_approved.wait()
            effects.append("dispatch")

        admitted = scope.admit(operation)
        await started.wait()
        scope.close()
        never_approved.set()
        with pytest.raises(asyncio.CancelledError):
            await admitted
        assert effects == []
        assert scope.pending_count == 0

    asyncio.run(scenario())


def test_completed_work_is_not_reclassified_by_close() -> None:
    async def scenario() -> None:
        scope = PortalInvocationScope()

        async def operation() -> str:
            return "completed"

        admitted = scope.admit(operation)
        assert await admitted == "completed"
        scope.close()
        scope.close()
        assert admitted.result() == "completed"
        assert scope.pending_count == 0

    asyncio.run(scenario())


def test_call_identity_is_stable_only_inside_its_originating_scope() -> None:
    async def scenario() -> None:
        first = PortalInvocationScope()
        second = PortalInvocationScope()
        assert first.qualify_call_id("item") == first.qualify_call_id("item")
        assert first.qualify_call_id("item") != second.qualify_call_id("item")
        assert first.qualify_call_id("item") != first.qualify_call_id("other")
        first.close()
        with pytest.raises(PortalScopeClosedError):
            first.qualify_call_id("item")
        second.close()

    asyncio.run(scenario())


def test_close_between_admission_and_scheduling_does_not_invoke_factory() -> None:
    async def scenario() -> None:
        scope = PortalInvocationScope()
        effects: list[str] = []

        async def operation() -> None:
            effects.append("dispatch")

        task = scope.admit(operation)
        scope.close()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert effects == []

    asyncio.run(scenario())


def test_recorded_decision_cannot_admit_retry_after_close() -> None:
    async def scenario() -> None:
        scope = PortalInvocationScope()
        effects: list[str] = []

        async def decision() -> str:
            effects.append("decision-recorded")
            return "approved"

        async def retry() -> None:
            effects.append("protected-effect")

        assert await scope.admit(decision) == "approved"
        scope.close()
        with pytest.raises(PortalScopeClosedError):
            scope.admit(retry)
        assert effects == ["decision-recorded"]

    asyncio.run(scenario())


def test_closing_one_scope_does_not_cancel_another_conversation() -> None:
    async def scenario() -> None:
        first = PortalInvocationScope()
        second = PortalInvocationScope()

        async def operation() -> str:
            return "second-conversation"

        admitted = second.admit(operation)
        first.close()
        assert await admitted == "second-conversation"
        second.close()

    asyncio.run(scenario())


def test_eager_task_factory_cannot_run_before_registration() -> None:
    async def scenario() -> None:
        loop = asyncio.get_running_loop()
        loop.set_task_factory(asyncio.eager_task_factory)
        scope = PortalInvocationScope()
        effects: list[str] = []

        async def effect() -> None:
            effects.append("dispatched")

        try:
            task = scope.admit(effect)
            scope.close()
            await asyncio.gather(task, return_exceptions=True)
            assert effects == []
        finally:
            loop.set_task_factory(None)

    asyncio.run(scenario())


def test_expired_deadline_blocks_decision_and_retry_without_waiting_for_process_exit() -> None:
    # Import-isolation tests reload SDK modules; bind the patched clock and class to the same module.
    from agent_vm_agent_portal_sdk import portal_invocation_scope as current_scope_module

    async def scenario() -> None:
        effects: list[str] = []

        async def operation() -> None:
            effects.append("effect")

        with patch("agent_vm_agent_portal_sdk.portal_invocation_scope.monotonic", return_value=100):
            scope = current_scope_module.PortalInvocationScope(deadline_monotonic=101)
            await scope.admit(operation)
        with patch("agent_vm_agent_portal_sdk.portal_invocation_scope.monotonic", return_value=101), pytest.raises(current_scope_module.PortalScopeClosedError):
            scope.admit(operation)
        assert effects == ["effect"]
        scope.close()

    asyncio.run(scenario())
