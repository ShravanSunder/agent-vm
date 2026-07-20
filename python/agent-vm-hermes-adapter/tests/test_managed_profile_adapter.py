import unittest

from agent_vm_agent_portal_sdk.gateway_runtime_client import GatewayRuntimeClient

from agent_vm_hermes_adapter import (
    HermesManagedAdapter,
    HermesManagedAdapterConfig,
    HermesProfileAdmissionError,
)

PROJECTION_COHORT_DIGEST = (
    "projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
)


class FakeSessionSource:
    def __init__(self, profile: str | None) -> None:
        self.profile = profile


def build_projection(*, agent_id: str, profile_name: str) -> dict[str, object]:
    return {
        "agentId": agent_id,
        "frameworkIdentity": {"kind": "hermes", "profileName": profile_name},
        "profileAssignmentRevision": f"revision-{agent_id}",
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

        self.assertEqual(researcher["agentId"], "researcher")
        self.assertEqual(reviewer["agentId"], "reviewer")
        self.assertEqual(
            set(researcher),
            {
                "agentId",
                "frameworkIdentity",
                "profileAssignmentRevision",
                "toolPortalProfileId",
            },
        )
        self.assertIs(adapter.gateway_runtime_client_for_profile("researcher"), client)
        self.assertIs(adapter.gateway_runtime_client_for_profile("reviewer"), client)

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

        self.assertEqual(adapter_config.profiles[0]["agentId"], opaque_agent_id)
        self.assertNotIn("selfRoot", adapter_config.profiles[0])
        self.assertNotIn("workRoot", adapter_config.profiles[0])

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


if __name__ == "__main__":
    unittest.main()
