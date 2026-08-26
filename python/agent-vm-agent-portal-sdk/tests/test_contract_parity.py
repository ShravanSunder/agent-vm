import json
import typing as t
from pathlib import Path

import pytest
from agent_vm_agent_portal_sdk.contracts import (
    PORTABLE_CONTRACT_ADAPTERS,
    PORTABLE_REFINEMENT_IDENTITIES,
    encode_canonical_json,
    get_portable_contract_json_schema,
)
from pydantic import TypeAdapter, ValidationError

type FixtureObject = dict[str, object]
type LoadedFixture = tuple[str, FixtureObject]


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
PORTABLE_CONTRACT_FIXTURE_ROOT = REPOSITORY_ROOT / "packages" / "agent-portal-sdk" / "contract-fixtures" / "portable-contracts"
FIXTURE_DOCUMENT_KEYS = frozenset({"caseId", "schemaId", "tags", "input", "expectation"})
ACCEPTED_EXPECTATION_KEYS = frozenset({"kind", "normalized", "canonicalJson", "refinementIdentities"})
REJECTED_EXPECTATION_KEYS = frozenset({"kind", "errorCodes", "refinementIdentities"})
REQUIRED_BEHAVIOR_TAG_KINDS: t.Mapping[str, frozenset[str]] = {
    "byte-bound": frozenset({"accepted", "rejected"}),
    "canonical-json": frozenset({"accepted"}),
    "default": frozenset({"accepted"}),
    "duplicate-id": frozenset({"rejected"}),
    "numeric": frozenset({"accepted", "rejected"}),
    "outcome": frozenset({"accepted", "rejected"}),
    "reserved-id": frozenset({"rejected"}),
    "unknown-field": frozenset({"rejected"}),
}


def test_portable_contract_json_schema_accessor_is_copy_safe() -> None:
    # Arrange
    schema_id = "portal.call.request"

    # Act
    first_schema = get_portable_contract_json_schema(schema_id)
    first_schema["mutated"] = True
    second_schema = get_portable_contract_json_schema(schema_id)

    # Assert
    assert second_schema["type"] == "object"
    assert "mutated" not in second_schema
    assert second_schema == get_portable_contract_json_schema(schema_id)


def test_portable_contract_json_schema_accessor_rejects_unknown_schema_id() -> None:
    # Arrange
    unknown_schema_id = "portal.unknown.request"

    # Act / Assert
    with pytest.raises(KeyError, match="Unknown portable contract schema"):
        _ = get_portable_contract_json_schema(unknown_schema_id)


@pytest.mark.parametrize(
    "namespace_discovery",
    [
        pytest.param(
            [{"namespace": "github"}, {"namespace": "filesystem"}],
            id="unsorted",
        ),
        pytest.param(
            [{"namespace": "filesystem"}, {"namespace": "filesystem"}],
            id="duplicate",
        ),
    ],
)
def test_generated_managed_agent_projection_adapter_rejects_noncanonical_namespace_discovery(
    namespace_discovery: list[FixtureObject],
) -> None:
    # Arrange
    contract_adapter: TypeAdapter[object] = PORTABLE_CONTRACT_ADAPTERS["gateway.managed-agent-projection"]
    projection = {
        "agentId": "agent-a",
        "frameworkIdentity": {"kind": "hermes", "profileName": "agent-a"},
        "profileAssignmentRevision": "profile-assignment-a",
        "toolPortalNamespaces": namespace_discovery,
        "toolPortalProfileId": "engineering",
    }

    # Act / Assert
    with pytest.raises(ValidationError) as captured_validation_error:
        _ = contract_adapter.validate_python(projection, strict=True)

    assert _portable_validation_error_codes(captured_validation_error.value) == frozenset(
        {"gateway.managed-agent-projection.namespaces"},
    )


def _require_fixture_object(value: object, *, label: str) -> FixtureObject:
    if not isinstance(value, dict):
        pytest.fail(f"{label} must be a JSON object with string keys.")
    object_mapping = t.cast("dict[object, object]", value)
    if not all(isinstance(key, str) for key in object_mapping):
        pytest.fail(f"{label} must be a JSON object with string keys.")
    return t.cast("FixtureObject", object_mapping)


def _require_fixture_string(value: object, *, label: str) -> str:
    if not isinstance(value, str) or not value:
        pytest.fail(f"{label} must be a non-empty string.")
    return value


def _require_fixture_string_list(value: object, *, label: str) -> tuple[str, ...]:
    if not isinstance(value, list):
        pytest.fail(f"{label} must be an array of non-empty strings.")
    object_list = t.cast("list[object]", value)
    if not all(isinstance(item, str) and item for item in object_list):
        pytest.fail(f"{label} must be an array of non-empty strings.")
    return tuple(t.cast("list[str]", object_list))


def _load_portable_contract_fixtures() -> tuple[LoadedFixture, ...]:
    if not PORTABLE_CONTRACT_FIXTURE_ROOT.is_dir():
        missing_fixture_directory_message = f"The parent-owned portable contract fixture directory is missing: {PORTABLE_CONTRACT_FIXTURE_ROOT}"
        raise FileNotFoundError(missing_fixture_directory_message)

    fixture_paths = tuple(sorted(PORTABLE_CONTRACT_FIXTURE_ROOT.rglob("*.fixture.json")))
    if not fixture_paths:
        missing_fixture_corpus_message = "The parent-owned portable contract corpus contains no recursive *.fixture.json documents."
        raise FileNotFoundError(missing_fixture_corpus_message)

    loaded_fixtures: list[LoadedFixture] = []
    for fixture_path in fixture_paths:
        fixture_input = t.cast("object", json.loads(fixture_path.read_text(encoding="utf-8")))
        fixture_label = fixture_path.relative_to(REPOSITORY_ROOT).as_posix()
        loaded_fixtures.append(
            (
                fixture_label,
                _require_fixture_object(fixture_input, label=fixture_label),
            ),
        )
    return tuple(loaded_fixtures)


def _fixture_case_id(loaded_fixture: LoadedFixture) -> str:
    fixture_label, fixture = loaded_fixture
    case_id = fixture.get("caseId")
    return case_id if isinstance(case_id, str) and case_id else fixture_label


def _fixture_expectation(fixture_label: str, fixture: FixtureObject) -> FixtureObject:
    return _require_fixture_object(
        fixture.get("expectation"),
        label=f"{fixture_label}.expectation",
    )


def _portable_validation_error_codes(validation_error: ValidationError) -> frozenset[str]:
    error_codes: set[str] = set()
    for error_detail in validation_error.errors(
        include_context=True,
        include_input=False,
        include_url=False,
    ):
        error_code = error_detail.get("type")
        if not error_code:
            pytest.fail("Generated Pydantic validation errors must carry portable error codes.")
        error_codes.add(error_code)
    return frozenset(error_codes)


PORTABLE_CONTRACT_FIXTURES = _load_portable_contract_fixtures()

SANDBOX_ENVIRONMENT_HANDLE: FixtureObject = {
    "handleId": "environment-a",
    "kind": "environment",
    "owningGeneration": "generation-a",
}
SANDBOX_ENVIRONMENT_ROOT_CASES: tuple[tuple[str, FixtureObject], ...] = (
    ("sandbox.environment.open.request", {}),
    (
        "sandbox.environment.open.result",
        {"environment": SANDBOX_ENVIRONMENT_HANDLE, "kind": "opened"},
    ),
    (
        "sandbox.environment.status.result",
        {"environment": SANDBOX_ENVIRONMENT_HANDLE, "kind": "active"},
    ),
)


@pytest.mark.parametrize(("schema_id", "root_value"), SANDBOX_ENVIRONMENT_ROOT_CASES)
def test_sandbox_environment_contracts_represent_work_root_by_omitted_logical_cwd(
    schema_id: str,
    root_value: FixtureObject,
) -> None:
    # Arrange
    contract_adapter: TypeAdapter[object] = PORTABLE_CONTRACT_ADAPTERS[schema_id]

    # Act
    validated_value = contract_adapter.validate_python(root_value, strict=True)
    normalized_value = contract_adapter.dump_python(
        validated_value,
        by_alias=True,
        exclude_none=True,
        mode="json",
    )

    # Assert
    assert normalized_value == root_value


@pytest.mark.parametrize(("schema_id", "root_value"), SANDBOX_ENVIRONMENT_ROOT_CASES)
def test_sandbox_environment_contracts_preserve_strict_present_child_logical_cwd(
    schema_id: str,
    root_value: FixtureObject,
) -> None:
    # Arrange
    contract_adapter: TypeAdapter[object] = PORTABLE_CONTRACT_ADAPTERS[schema_id]
    child_value = {**root_value, "logicalCwd": "repo/subdir"}

    # Act
    validated_value = contract_adapter.validate_python(child_value, strict=True)
    normalized_value = contract_adapter.dump_python(
        validated_value,
        by_alias=True,
        exclude_none=True,
        mode="json",
    )

    # Assert
    assert normalized_value == child_value


@pytest.mark.parametrize(("schema_id", "root_value"), SANDBOX_ENVIRONMENT_ROOT_CASES)
@pytest.mark.parametrize("invalid_logical_cwd", ["", ".", "/work", "../repo", "repo/../subdir", "repo//subdir"])
def test_sandbox_environment_contracts_reject_invalid_present_logical_cwd(
    schema_id: str,
    root_value: FixtureObject,
    invalid_logical_cwd: str,
) -> None:
    # Arrange
    contract_adapter: TypeAdapter[object] = PORTABLE_CONTRACT_ADAPTERS[schema_id]

    # Act / Assert
    with pytest.raises(ValidationError):
        _ = contract_adapter.validate_python(
            {**root_value, "logicalCwd": invalid_logical_cwd},
            strict=True,
        )


def test_portable_contract_fixture_corpus_covers_required_behavior() -> None:
    # Arrange
    case_ids: list[str] = []
    observed_tag_kinds: dict[str, set[str]] = {}

    # Act
    for fixture_label, fixture in PORTABLE_CONTRACT_FIXTURES:
        assert frozenset(fixture) == FIXTURE_DOCUMENT_KEYS, fixture_label
        case_id = _require_fixture_string(
            fixture.get("caseId"),
            label=f"{fixture_label}.caseId",
        )
        _ = _require_fixture_string(
            fixture.get("schemaId"),
            label=f"{fixture_label}.schemaId",
        )
        tags = _require_fixture_string_list(
            fixture.get("tags"),
            label=f"{fixture_label}.tags",
        )
        expectation = _fixture_expectation(fixture_label, fixture)
        expectation_kind = _require_fixture_string(
            expectation.get("kind"),
            label=f"{fixture_label}.expectation.kind",
        )
        if expectation_kind == "accepted":
            assert frozenset(expectation) == ACCEPTED_EXPECTATION_KEYS, fixture_label
            _ = _require_fixture_string(
                expectation.get("canonicalJson"),
                label=f"{fixture_label}.expectation.canonicalJson",
            )
        elif expectation_kind == "rejected":
            assert frozenset(expectation) == REJECTED_EXPECTATION_KEYS, fixture_label
            error_codes = _require_fixture_string_list(
                expectation.get("errorCodes"),
                label=f"{fixture_label}.expectation.errorCodes",
            )
            assert len(error_codes) == len(set(error_codes)), fixture_label
        else:
            pytest.fail(f"{fixture_label}.expectation.kind is not accepted or rejected.")

        _ = _require_fixture_string_list(
            expectation.get("refinementIdentities"),
            label=f"{fixture_label}.expectation.refinementIdentities",
        )
        case_ids.append(case_id)
        for tag in tags:
            observed_tag_kinds.setdefault(tag, set()).add(expectation_kind)

    # Assert
    assert len(case_ids) == len(set(case_ids)), "Portable fixture caseId values must be unique."
    for behavior_tag, required_kinds in REQUIRED_BEHAVIOR_TAG_KINDS.items():
        assert required_kinds <= observed_tag_kinds.get(behavior_tag, set()), (
            f"Portable fixture tag {behavior_tag!r} must cover {sorted(required_kinds)} expectations."
        )


def test_fixture_schemas_use_generated_pydantic_v2_adapters() -> None:
    # Arrange
    fixture_schema_ids = {
        _require_fixture_string(
            fixture.get("schemaId"),
            label=f"{fixture_label}.schemaId",
        )
        for fixture_label, fixture in PORTABLE_CONTRACT_FIXTURES
    }

    # Act
    missing_schema_ids = fixture_schema_ids - PORTABLE_CONTRACT_ADAPTERS.keys()
    fixture_adapters = {schema_id: PORTABLE_CONTRACT_ADAPTERS[schema_id] for schema_id in fixture_schema_ids if schema_id in PORTABLE_CONTRACT_ADAPTERS}

    # Assert
    assert not missing_schema_ids, f"Missing generated contract adapters: {sorted(missing_schema_ids)}"
    assert all(isinstance(adapter, TypeAdapter) for adapter in fixture_adapters.values())


def test_every_generated_adapter_has_an_accepted_shared_fixture() -> None:
    # Arrange
    accepted_fixture_schema_ids = {
        _require_fixture_string(
            fixture.get("schemaId"),
            label=f"{fixture_label}.schemaId",
        )
        for fixture_label, fixture in PORTABLE_CONTRACT_FIXTURES
        if _fixture_expectation(fixture_label, fixture).get("kind") == "accepted"
    }

    # Act
    missing_accepted_schema_ids = PORTABLE_CONTRACT_ADAPTERS.keys() - accepted_fixture_schema_ids

    # Assert
    assert not missing_accepted_schema_ids, f"Generated adapters without an accepted shared fixture: {sorted(missing_accepted_schema_ids)}"


def test_fixture_refinement_identities_match_generated_manifest() -> None:
    # Arrange
    expected_refinement_identities: set[str] = set()
    for fixture_label, fixture in PORTABLE_CONTRACT_FIXTURES:
        expectation = _fixture_expectation(fixture_label, fixture)
        expected_refinement_identities.update(
            _require_fixture_string_list(
                expectation.get("refinementIdentities"),
                label=f"{fixture_label}.expectation.refinementIdentities",
            ),
        )

    # Act
    generated_refinement_identities = tuple(PORTABLE_REFINEMENT_IDENTITIES)

    # Assert
    assert all(isinstance(refinement_identity, str) and refinement_identity for refinement_identity in generated_refinement_identities)
    assert len(generated_refinement_identities) == len(set(generated_refinement_identities))
    assert set(generated_refinement_identities) == expected_refinement_identities


@pytest.mark.parametrize(
    "loaded_fixture",
    PORTABLE_CONTRACT_FIXTURES,
    ids=_fixture_case_id,
)
def test_generated_python_contract_matches_transport_neutral_fixture(
    loaded_fixture: LoadedFixture,
) -> None:
    # Arrange
    fixture_label, fixture = loaded_fixture
    schema_id = _require_fixture_string(
        fixture.get("schemaId"),
        label=f"{fixture_label}.schemaId",
    )
    contract_adapter: TypeAdapter[object] = PORTABLE_CONTRACT_ADAPTERS[schema_id]
    contract_input = fixture.get("input")
    expectation = _fixture_expectation(fixture_label, fixture)
    expectation_kind = _require_fixture_string(
        expectation.get("kind"),
        label=f"{fixture_label}.expectation.kind",
    )
    expected_refinement_identities = frozenset(
        _require_fixture_string_list(
            expectation.get("refinementIdentities"),
            label=f"{fixture_label}.expectation.refinementIdentities",
        ),
    )

    if expectation_kind == "accepted":
        # Act
        validated_value = contract_adapter.validate_python(contract_input, strict=True)
        normalized_value = t.cast(
            "object",
            contract_adapter.dump_python(
                validated_value,
                by_alias=True,
                mode="json",
            ),
        )
        actual_canonical_json = encode_canonical_json(normalized_value)
        expected_canonical_json = _require_fixture_string(
            expectation.get("canonicalJson"),
            label=f"{fixture_label}.expectation.canonicalJson",
        )

        # Assert
        assert normalized_value == expectation.get("normalized"), fixture_label
        assert actual_canonical_json == expected_canonical_json, fixture_label
        assert actual_canonical_json.encode("utf-8") == expected_canonical_json.encode("utf-8")
        assert json.loads(actual_canonical_json) == normalized_value
        assert expected_refinement_identities <= set(PORTABLE_REFINEMENT_IDENTITIES)
        return

    if expectation_kind != "rejected":
        pytest.fail(f"{fixture_label}.expectation.kind is not accepted or rejected.")

    # Act
    with pytest.raises(ValidationError) as captured_validation_error:
        _ = contract_adapter.validate_python(contract_input, strict=True)
    actual_error_codes = _portable_validation_error_codes(captured_validation_error.value)
    expected_error_codes = frozenset(
        _require_fixture_string_list(
            expectation.get("errorCodes"),
            label=f"{fixture_label}.expectation.errorCodes",
        ),
    )

    # Assert
    assert actual_error_codes == expected_error_codes, fixture_label
    assert expected_refinement_identities <= set(PORTABLE_REFINEMENT_IDENTITIES)
