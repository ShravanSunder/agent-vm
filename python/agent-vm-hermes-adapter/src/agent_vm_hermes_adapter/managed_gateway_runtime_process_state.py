"""State and response validation for Hermes managed background processes."""

import threading
import typing as t

from tools.process_registry import ProcessSession

from .managed_gateway_runtime_environment import HermesGatewayRuntimeEnvironment
from .managed_profile_adapter import (
    CanonicalManagedAgentProjection,
    _projection_profile_name,
    _projection_string_field,
)


@t.final
class HermesManagedProcessOwner:
    def __init__(
        self,
        *,
        agent_id: str,
        assignment_revision: str,
        cache_identity: str,
        owning_generation: str,
        profile_name: str,
    ) -> None:
        self.agent_id = agent_id
        self.assignment_revision = assignment_revision
        self.cache_identity = cache_identity
        self.owning_generation = owning_generation
        self.profile_name = profile_name

    def matches_projection(self, projection: CanonicalManagedAgentProjection) -> bool:
        return (
            self.agent_id == _projection_string_field(projection, "agentId")
            and self.assignment_revision
            == _projection_string_field(projection, "profileAssignmentRevision")
            and self.profile_name == _projection_profile_name(projection)
        )


@t.final
class HermesManagedProcessRecord:
    def __init__(
        self,
        *,
        environment: HermesGatewayRuntimeEnvironment,
        owner: HermesManagedProcessOwner,
        process: t.Mapping[str, object],
        session: ProcessSession,
        streams_by_channel: t.Mapping[str, t.Mapping[str, object]],
    ) -> None:
        self.environment = environment
        self.owner = owner
        self.process = process
        self.session = session
        self.streams_by_channel = streams_by_channel
        self.log_state_lock = threading.Lock()
        self.log_cursor: str | None = None
        self.latest_log_sequence_by_channel: dict[str, int] = {}
        self.input_state_lock = threading.Lock()
        self.next_input_sequence = 0
        self.input_closed = False
        self.finished = False


def require_process_mapping(value: object, label: str) -> t.Mapping[str, object]:
    if not isinstance(value, t.Mapping):
        raise TypeError(f"{label} must be an object")
    return t.cast("t.Mapping[str, object]", value)


def require_process_string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise TypeError(f"{label} must be a non-empty string")
    return value


def require_nonnegative_process_integer(value: object, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise TypeError(f"{label} must be a nonnegative integer")
    return value


def terminal_process_exit_code(outcome: t.Mapping[str, object]) -> int:
    outcome_kind = require_process_string(outcome.get("kind"), "process outcome kind")
    if outcome_kind == "completed":
        return 0 if outcome.get("completion") == "succeeded" else 1
    if outcome_kind == "cancelled-proven":
        return 130
    if outcome_kind == "timed-out-proven":
        return 124
    return 125


def process_completion_reason(outcome: t.Mapping[str, object]) -> str:
    outcome_kind = require_process_string(outcome.get("kind"), "process outcome kind")
    if outcome_kind == "cancelled-proven":
        return "killed"
    if outcome_kind == "replaced-proven":
        return "lost"
    if outcome_kind == "not-dispatched":
        return "failed_start"
    return "exited"
