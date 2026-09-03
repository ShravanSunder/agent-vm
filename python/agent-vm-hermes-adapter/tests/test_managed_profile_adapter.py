import asyncio
import concurrent.futures
import threading
import unittest

from agent_vm_agent_portal_sdk.gateway_runtime_client import GatewayRuntimeClient
from pydantic import ValidationError

from agent_vm_hermes_adapter.managed_gateway_runtime_client_loop import GatewayRuntimeClientLoop
from agent_vm_hermes_adapter.managed_profile_adapter import (
    CanonicalManagedAgentProjection,
    HermesManagedAdapter,
    HermesManagedAdapterConfig,
    HermesProfileAdmissionError,
    ManagedTrustedContext,
    build_managed_trusted_context,
)
from agent_vm_hermes_adapter.managed_tool_portal.models import NamespaceDiscovery

PROJECTION_COHORT_DIGEST = (
    "projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
)


class FakeSessionSource:
    def __init__(self, profile: str | None) -> None:
        self.profile = profile


def build_projection(
    *,
    agent_id: str,
    profile_name: str,
    tool_portal_namespaces: tuple[dict[str, str], ...] = ({"namespace": "filesystem"},),
) -> dict[str, object]:
    return {
        "agentId": agent_id,
        "frameworkIdentity": {"kind": "hermes", "profileName": profile_name},
        "profileAssignmentRevision": f"revision-{agent_id}",
        "toolPortalNamespaces": list(tool_portal_namespaces),
        "toolPortalProfileId": f"policy-{agent_id}",
    }


def build_unconnected_gateway_runtime_client() -> GatewayRuntimeClient:
    return object.__new__(GatewayRuntimeClient)


def build_adapter_config(
    profiles: tuple[dict[str, object], ...],
) -> HermesManagedAdapterConfig:
    return HermesManagedAdapterConfig(
        profiles=profiles,
        projection_cohort_digest=PROJECTION_COHORT_DIGEST,
        protected_hermes_home="/var/lib/agent-vm/hermes",
    )


class HermesManagedAdapterTests(unittest.TestCase):
    def test_counts_namespace_summary_bounds_by_unicode_code_point(self) -> None:
        supplementary_character = "\U0001f680"
        valid_projection = build_projection(
            agent_id="reviewer",
            profile_name="reviewer",
            tool_portal_namespaces=(
                {"namespace": "unicode", "summary": supplementary_character * 500},
            ),
        )
        over_bound_projection = build_projection(
            agent_id="reviewer",
            profile_name="reviewer",
            tool_portal_namespaces=(
                {"namespace": "unicode", "summary": supplementary_character * 501},
            ),
        )

        self.assertEqual(
            CanonicalManagedAgentProjection.model_validate(valid_projection)
            .tool_portal_namespaces[0]
            .summary,
            supplementary_character * 500,
        )
        with self.assertRaises(ValidationError):
            CanonicalManagedAgentProjection.model_validate(over_bound_projection)

    def test_routes_two_canonical_profiles_through_one_injected_client(self) -> None:
        client = build_unconnected_gateway_runtime_client()
        adapter = HermesManagedAdapter(
            config=build_adapter_config(
                (
                    build_projection(agent_id="researcher", profile_name="researcher"),
                    build_projection(agent_id="reviewer", profile_name="reviewer"),
                )
            ),
            gateway_runtime_client=client,
        )

        researcher = adapter.admit_session_source(FakeSessionSource("researcher"))
        reviewer = adapter.admit_session_source(FakeSessionSource("reviewer"))

        self.assertEqual(researcher.agent_id, "researcher")
        self.assertEqual(reviewer.agent_id, "reviewer")
        self.assertEqual(
            set(researcher.model_dump(by_alias=True)),
            {
                "agentId",
                "frameworkIdentity",
                "profileAssignmentRevision",
                "toolPortalNamespaces",
                "toolPortalProfileId",
            },
        )
        self.assertIsInstance(researcher, CanonicalManagedAgentProjection)
        self.assertEqual(
            researcher.tool_portal_namespaces,
            (NamespaceDiscovery(namespace="filesystem"),),
        )
        self.assertIs(adapter.gateway_runtime_client_for_profile("researcher"), client)
        self.assertIs(adapter.gateway_runtime_client_for_profile("reviewer"), client)

    def test_rejects_missing_unsorted_and_duplicate_namespace_names(self) -> None:
        missing_names = build_projection(agent_id="reviewer", profile_name="reviewer")
        del missing_names["toolPortalNamespaces"]

        cases = (
            missing_names,
            build_projection(
                agent_id="reviewer",
                profile_name="reviewer",
                tool_portal_namespaces=(
                    {"namespace": "zeta"},
                    {"namespace": "alpha"},
                ),
            ),
            build_projection(
                agent_id="reviewer",
                profile_name="reviewer",
                tool_portal_namespaces=(
                    {"namespace": "alpha"},
                    {"namespace": "alpha"},
                ),
            ),
            build_projection(
                agent_id="reviewer",
                profile_name="reviewer",
                tool_portal_namespaces=({"namespace": ""},),
            ),
        )

        for projection in cases:
            with self.subTest(projection=projection):
                with self.assertRaises(ValidationError):
                    CanonicalManagedAgentProjection.model_validate(projection)
                with self.assertRaises(ValidationError):
                    build_adapter_config((projection,))

    def test_projection_and_nested_identity_are_immutable(self) -> None:
        projection = build_adapter_config(
            (build_projection(agent_id="reviewer", profile_name="reviewer"),)
        ).profiles[0]

        with self.assertRaises(ValidationError):
            setattr(projection, "agent_id", "changed")
        with self.assertRaises(ValidationError):
            setattr(projection.framework_identity, "profile_name", "changed")
        with self.assertRaises(ValidationError):
            setattr(projection, "tool_portal_namespaces", ({"namespace": "filesystem"},))

    def test_builds_exact_trusted_context_wire_shape_without_session(self) -> None:
        projection = build_adapter_config(
            (build_projection(agent_id="reviewer", profile_name="reviewer"),)
        ).profiles[0]

        trusted_context = build_managed_trusted_context(projection)

        self.assertIsInstance(trusted_context, ManagedTrustedContext)
        self.assertEqual(
            trusted_context.model_dump(by_alias=True, mode="json", exclude_none=True),
            {
                "principal": {
                    "agentId": "reviewer",
                    "frameworkIdentity": {"kind": "hermes", "profileName": "reviewer"},
                    "profileAssignmentRevision": "revision-reviewer",
                    "toolPortalProfileId": "policy-reviewer",
                },
            },
        )

    def test_builds_exact_trusted_context_wire_shape_with_session(self) -> None:
        projection = build_adapter_config(
            (build_projection(agent_id="reviewer", profile_name="reviewer"),)
        ).profiles[0]

        trusted_context = build_managed_trusted_context(projection, session_id="session-1")

        self.assertEqual(
            trusted_context.model_dump(by_alias=True, mode="json", exclude_none=True),
            {
                "correlation": {"sessionId": "session-1"},
                "principal": {
                    "agentId": "reviewer",
                    "frameworkIdentity": {"kind": "hermes", "profileName": "reviewer"},
                    "profileAssignmentRevision": "revision-reviewer",
                    "toolPortalProfileId": "policy-reviewer",
                },
            },
        )

    def test_rejects_missing_default_and_unknown_profiles(self) -> None:
        adapter = HermesManagedAdapter(
            config=build_adapter_config(
                (build_projection(agent_id="researcher", profile_name="researcher"),)
            ),
            gateway_runtime_client=build_unconnected_gateway_runtime_client(),
        )

        for profile_name in (None, "", "default", "undeclared"):
            with self.subTest(profile_name=profile_name):
                with self.assertRaises(HermesProfileAdmissionError):
                    adapter.admit_session_source(FakeSessionSource(profile_name))

    def test_rejects_duplicate_profiles_and_agents(self) -> None:
        cases = (
            (
                build_projection(agent_id="researcher", profile_name="researcher"),
                build_projection(agent_id="reviewer", profile_name="researcher"),
            ),
            (
                build_projection(agent_id="researcher", profile_name="researcher"),
                build_projection(agent_id="researcher", profile_name="reviewer"),
            ),
        )

        for profiles in cases:
            with self.subTest(profiles=profiles):
                with self.assertRaises(ValueError):
                    build_adapter_config(profiles)

    def test_rejects_case_normalization_before_cohort_admission(self) -> None:
        with self.assertRaises(ValueError):
            build_adapter_config(
                (build_projection(agent_id="reviewer", profile_name="Researcher"),)
            )

    def test_treats_agent_id_as_opaque_identity_not_path_authority(self) -> None:
        opaque_agent_id = "reviewer/../reviewer"
        adapter_config = build_adapter_config(
            (
                build_projection(
                    agent_id=opaque_agent_id,
                    profile_name="reviewer",
                ),
            )
        )

        self.assertEqual(adapter_config.profiles[0].agent_id, opaque_agent_id)
        self.assertNotIn("selfRoot", adapter_config.profiles[0].model_dump(by_alias=True))
        self.assertNotIn("workRoot", adapter_config.profiles[0].model_dump(by_alias=True))

    def test_rejects_retired_projection_roots(self) -> None:
        for field_name, field_value in (
            ("selfRoot", "/zone/agents/reviewer/self"),
            ("workRoot", "/zone/agents/reviewer/work"),
        ):
            with self.subTest(field_name=field_name):
                projection = {
                    **build_projection(agent_id="reviewer", profile_name="reviewer"),
                    field_name: field_value,
                }
                with self.assertRaises(ValueError):
                    build_adapter_config((projection,))

    def test_rejects_noncanonical_projection_shape(self) -> None:
        projection_with_extra_authority = {
            **build_projection(agent_id="reviewer", profile_name="reviewer"),
            "workspaceId": "retired-authority",
        }

        with self.assertRaises(ValueError):
            build_adapter_config((projection_with_extra_authority,))

    def test_rejects_non_normalized_protected_hermes_home_paths(self) -> None:
        invalid_paths = (
            "relative/hermes",
            "/var//lib/agent-vm/hermes",
            "/var/lib/agent-vm/hermes/",
            "/var/lib/./agent-vm/hermes",
            "/var/lib/../agent-vm/hermes",
            "/var/lib/agent-vm/\x00hermes",
        )

        for protected_hermes_home in invalid_paths:
            with self.subTest(protected_hermes_home=protected_hermes_home):
                with self.assertRaisesRegex(ValueError, "normalized absolute guest path"):
                    HermesManagedAdapterConfig(
                        profiles=(build_projection(agent_id="reviewer", profile_name="reviewer"),),
                        projection_cohort_digest=PROJECTION_COHORT_DIGEST,
                        protected_hermes_home=protected_hermes_home,
                    )

    def test_rejects_protected_hermes_home_inside_gateway_zone_files(self) -> None:
        for protected_hermes_home in ("/zone", "/zone/agents/reviewer"):
            with self.subTest(protected_hermes_home=protected_hermes_home):
                with self.assertRaisesRegex(ValueError, "Gateway zone files"):
                    HermesManagedAdapterConfig(
                        profiles=(build_projection(agent_id="reviewer", profile_name="reviewer"),),
                        projection_cohort_digest=PROJECTION_COHORT_DIGEST,
                        protected_hermes_home=protected_hermes_home,
                    )

    def test_rejects_guest_root_as_protected_hermes_home(self) -> None:
        with self.assertRaisesRegex(ValueError, "cannot be the guest root"):
            HermesManagedAdapterConfig(
                profiles=(build_projection(agent_id="reviewer", profile_name="reviewer"),),
                projection_cohort_digest=PROJECTION_COHORT_DIGEST,
                protected_hermes_home="/",
            )


class GatewayRuntimeClientLoopTests(unittest.TestCase):
    def test_run_cancels_submitted_coroutine_after_synchronous_timeout(self) -> None:
        # Arrange
        client_loop = GatewayRuntimeClientLoop(build_unconnected_gateway_runtime_client())
        cancellation_observed = threading.Event()

        async def wait_until_cancelled() -> None:
            try:
                await asyncio.Event().wait()
            finally:
                cancellation_observed.set()

        async def unrelated_operation() -> str:
            return "shared-loop-responsive"

        try:
            # Act
            with self.assertRaises(concurrent.futures.TimeoutError):
                client_loop.run(wait_until_cancelled(), timeout=0.01)

            # Assert
            self.assertTrue(cancellation_observed.wait(timeout=1))
            self.assertEqual(
                client_loop.run(unrelated_operation(), timeout=1),
                "shared-loop-responsive",
            )
        finally:
            client_loop.close(disconnect=False)


if __name__ == "__main__":
    unittest.main()
