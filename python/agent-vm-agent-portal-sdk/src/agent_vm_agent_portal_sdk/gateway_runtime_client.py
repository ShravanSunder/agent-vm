"""Private Gateway-runtime client over an injected UDS transport."""

import asyncio
import typing as t
from collections.abc import Mapping

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from .contracts import PORTABLE_CONTRACT_ADAPTERS
from .gateway_runtime_sandbox_operations import GatewayRuntimeSandboxOperations
from .gateway_runtime_uds_transport import GatewayRuntimeUdsTransport

DEFAULT_GATEWAY_RUNTIME_SOCKET_PATH = "/run/agent-vm/gateway-runtime/managed-plugin.sock"
GATEWAY_RUNTIME_TRACEPARENT_MAX_LENGTH = 512
GATEWAY_RUNTIME_TRACESTATE_MAX_LENGTH = 512
GATEWAY_RUNTIME_TRACESTATE_MAX_MEMBERS = 32
_W3C_TRACEPARENT_VERSION_ZERO_LENGTH = 55
_W3C_TRACESTATE_MEMBER_COMPONENT_MAX_LENGTH = 256
_ASCII_SPACE_CODE_POINT = 0x20
_ASCII_FIRST_VISIBLE_NON_SPACE_CODE_POINT = 0x21
_ASCII_LAST_VISIBLE_CODE_POINT = 0x7E
_W3C_TRACESTATE_SIMPLE_KEY_MAX_LENGTH = 256
_W3C_TRACESTATE_TENANT_ID_MAX_LENGTH = 241
_W3C_TRACESTATE_SYSTEM_ID_MAX_LENGTH = 14

_PUBLIC_AUTHORITY_FIELD_NAMES = frozenset(
    {
        "allowedOperationGroups",
        "authority",
        "operationGroups",
        "principal",
        "surface",
    },
)

_W3C_TRACESTATE_KEY_CHARACTERS = frozenset("abcdefghijklmnopqrstuvwxyz0123456789_*/-")


def _tracestate_key_is_valid(key: str) -> bool:
    if "@" not in key:
        return 1 <= len(key) <= _W3C_TRACESTATE_SIMPLE_KEY_MAX_LENGTH and key[0] in "abcdefghijklmnopqrstuvwxyz" and set(key) <= _W3C_TRACESTATE_KEY_CHARACTERS
    tenant_id, delimiter, system_id = key.partition("@")
    return (
        delimiter == "@"
        and "@" not in system_id
        and 1 <= len(tenant_id) <= _W3C_TRACESTATE_TENANT_ID_MAX_LENGTH
        and tenant_id[0] in "abcdefghijklmnopqrstuvwxyz0123456789"
        and set(tenant_id) <= _W3C_TRACESTATE_KEY_CHARACTERS
        and 1 <= len(system_id) <= _W3C_TRACESTATE_SYSTEM_ID_MAX_LENGTH
        and system_id[0] in "abcdefghijklmnopqrstuvwxyz"
        and set(system_id) <= _W3C_TRACESTATE_KEY_CHARACTERS
    )


class GatewayRuntimeTransport(t.Protocol):
    async def connect(self, socket_path: str) -> None: ...

    async def handshake(
        self,
        attachment: Mapping[str, object],
    ) -> Mapping[str, object]: ...

    async def request(
        self,
        method: str,
        params: Mapping[str, object],
    ) -> Mapping[str, object]: ...

    async def disconnect(self) -> None: ...


class GatewayRuntimeTraceContext(BaseModel):
    """Bounded W3C trace metadata carried outside public operation arguments."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    traceparent: str = Field(max_length=GATEWAY_RUNTIME_TRACEPARENT_MAX_LENGTH)
    tracestate: str | None = Field(default=None, max_length=GATEWAY_RUNTIME_TRACESTATE_MAX_LENGTH)

    @field_validator("traceparent")
    @classmethod
    def _validate_traceparent(cls, traceparent: str) -> str:
        if len(traceparent) < _W3C_TRACEPARENT_VERSION_ZERO_LENGTH:
            raise ValueError("traceparent is shorter than the W3C minimum.")
        if traceparent[2] != "-" or traceparent[35] != "-" or traceparent[52] != "-":
            raise ValueError("traceparent has malformed delimiters.")
        version = traceparent[:2]
        trace_id = traceparent[3:35]
        parent_id = traceparent[36:52]
        trace_flags = traceparent[53:55]
        lowercase_hex_characters = frozenset("0123456789abcdef")
        if (
            not set(version) <= lowercase_hex_characters
            or version == "ff"
            or not set(trace_id) <= lowercase_hex_characters
            or trace_id == "0" * 32
            or not set(parent_id) <= lowercase_hex_characters
            or parent_id == "0" * 16
            or not set(trace_flags) <= lowercase_hex_characters
        ):
            raise ValueError("traceparent has invalid W3C identifiers, version, or flags.")
        if len(traceparent) > _W3C_TRACEPARENT_VERSION_ZERO_LENGTH:
            future_suffix = traceparent[56:]
            if version == "00" or traceparent[55] != "-" or not future_suffix:
                raise ValueError("traceparent has an invalid version extension.")
            if any(
                ord(character) < _ASCII_FIRST_VISIBLE_NON_SPACE_CODE_POINT or ord(character) > _ASCII_LAST_VISIBLE_CODE_POINT for character in future_suffix
            ):
                raise ValueError("traceparent version extension contains an invalid character.")
        return traceparent

    @field_validator("tracestate")
    @classmethod
    def _validate_tracestate(cls, tracestate: str | None) -> str | None:
        if tracestate is None:
            return None
        raw_members = tracestate.split(",")
        if len(raw_members) > GATEWAY_RUNTIME_TRACESTATE_MAX_MEMBERS:
            raise ValueError("tracestate contains too many list members.")
        seen_keys: set[str] = set()
        for raw_member in raw_members:
            member = raw_member.strip(" \t")
            if not member:
                continue
            if member.count("=") != 1:
                raise ValueError("tracestate member must contain exactly one equals delimiter.")
            key, value = member.split("=", maxsplit=1)
            if not _tracestate_key_is_valid(key):
                raise ValueError("tracestate member key is invalid.")
            if (
                not 1 <= len(value) <= _W3C_TRACESTATE_MEMBER_COMPONENT_MAX_LENGTH
                or value[-1] == " "
                or any(character in ",=" or not _ASCII_SPACE_CODE_POINT <= ord(character) <= _ASCII_LAST_VISIBLE_CODE_POINT for character in value)
            ):
                raise ValueError("tracestate member value is invalid.")
            if key in seen_keys:
                raise ValueError("tracestate contains a duplicate key.")
            seen_keys.add(key)
        return tracestate


type GatewayRuntimeTraceContextProvider = t.Callable[[], Mapping[str, object] | None]


class GatewayRuntimeClientError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class GatewayRuntimeStartupRetryPolicy(BaseModel):
    """Bound expected socket pre-publication retries by time and attempts."""

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        strict=True,
    )

    deadline_milliseconds: int = Field(default=5_000, alias="deadlineMs", gt=0, le=60_000)
    interval_milliseconds: int = Field(default=100, alias="intervalMs", gt=0, le=60_000)
    maximum_attempts: int = Field(default=50, alias="maxAttempts", gt=0, le=1_000)

    @model_validator(mode="after")
    def _validate_interval_within_deadline(self) -> t.Self:
        if self.interval_milliseconds > self.deadline_milliseconds:
            policy_error_message = "Gateway runtime retry interval cannot exceed its startup deadline."
            raise ValueError(policy_error_message)
        return self


DEFAULT_GATEWAY_RUNTIME_STARTUP_RETRY_POLICY = GatewayRuntimeStartupRetryPolicy()


class GatewayRuntimeStartupRetryScheduler(t.Protocol):
    def now_milliseconds(self) -> float: ...

    async def wait(self, delay_milliseconds: float) -> None: ...


class AsyncioGatewayRuntimeStartupRetryScheduler:
    def now_milliseconds(self) -> float:
        return asyncio.get_running_loop().time() * 1_000

    async def wait(self, delay_milliseconds: float) -> None:
        await asyncio.sleep(delay_milliseconds / 1_000)


DEFAULT_GATEWAY_RUNTIME_STARTUP_RETRY_SCHEDULER = AsyncioGatewayRuntimeStartupRetryScheduler()


class GatewayRuntimeStartupUnavailableError(Exception):
    code = "startup-unavailable"

    def __init__(
        self,
        kind: t.Literal["socket-absent", "socket-refused"],
        *,
        cause: BaseException | None = None,
    ) -> None:
        super().__init__(f"Gateway runtime startup socket is unavailable: {kind}.")
        self.kind = kind
        self.__cause__ = cause


class GatewayRuntimeStartupRetryExhaustedError(GatewayRuntimeClientError):
    def __init__(
        self,
        *,
        attempts: int,
    ) -> None:
        super().__init__(
            "startup-retry-exhausted",
            f"Gateway runtime startup retry was exhausted after {attempts} attempts.",
        )
        self.attempts = attempts


def _validate_portable_mapping(
    schema_id: str,
    value: Mapping[str, object],
) -> dict[str, object]:
    validated_value = PORTABLE_CONTRACT_ADAPTERS[schema_id].validate_python(value)
    if not isinstance(validated_value, BaseModel):
        invalid_mapping_message = f"Portable contract {schema_id!r} did not produce a typed model."
        raise TypeError(invalid_mapping_message)
    normalized_value = validated_value.model_dump(
        by_alias=True,
        mode="json",
        exclude_none=True,
    )
    if not isinstance(normalized_value, dict):
        invalid_mapping_message = f"Portable contract {schema_id!r} did not produce a JSON object."
        raise TypeError(invalid_mapping_message)
    return t.cast("dict[str, object]", normalized_value)


def _validate_attachment(
    attachment: Mapping[str, object],
) -> Mapping[str, object]:
    if _PUBLIC_AUTHORITY_FIELD_NAMES.intersection(attachment):
        error_code = "public-authority-injection"
        error_message = "Gateway runtime attachment metadata cannot carry server authority."
        raise GatewayRuntimeClientError(
            error_code,
            error_message,
        )

    try:
        return _validate_portable_mapping("gateway.attachment.metadata", attachment)
    except ValidationError as error:
        raise GatewayRuntimeClientError(
            "invalid-attachment",
            "Gateway runtime attachment metadata is invalid.",
        ) from error


def _validate_trusted_invocation_context(
    trusted_context: Mapping[str, object],
) -> Mapping[str, object]:
    return _validate_portable_mapping(
        "gateway.trusted-invocation-context",
        trusted_context,
    )


def _validate_trace_context(trace_context: Mapping[str, object]) -> Mapping[str, object]:
    return GatewayRuntimeTraceContext.model_validate(trace_context).model_dump(
        mode="json",
        exclude_none=True,
    )


class _GatewayRuntimePortalOperations:
    def __init__(self, client: "GatewayRuntimeClient") -> None:
        self._client = client

    async def _execute_portal_operation(
        self,
        *,
        operation_name: t.Literal["list", "search", "describe", "call"],
        request: Mapping[str, object],
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        validated_request = PORTABLE_CONTRACT_ADAPTERS[f"portal.{operation_name}.request"].validate_python(request)
        if not isinstance(validated_request, BaseModel):
            invalid_request_message = f"Portal {operation_name} request did not produce a typed model."
            raise TypeError(invalid_request_message)
        response = await self._client.request(
            f"portal.{operation_name}",
            {
                "publicRequest": validated_request.model_dump(
                    by_alias=True,
                    mode="json",
                    exclude_none=True,
                ),
                "trustedContext": _validate_trusted_invocation_context(trusted_context),
            },
        )
        validated_result = PORTABLE_CONTRACT_ADAPTERS[f"portal.{operation_name}.result"].validate_python(response)
        if not isinstance(validated_result, BaseModel):
            invalid_result_message = f"Portal {operation_name} result did not produce a typed model."
            raise TypeError(invalid_result_message)
        return validated_result

    async def list(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute_portal_operation(
            operation_name="list",
            request=request,
            trusted_context=trusted_context,
        )

    async def search(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute_portal_operation(
            operation_name="search",
            request=request,
            trusted_context=trusted_context,
        )

    async def describe(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute_portal_operation(
            operation_name="describe",
            request=request,
            trusted_context=trusted_context,
        )

    async def call(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute_portal_operation(
            operation_name="call",
            request=request,
            trusted_context=trusted_context,
        )


class _GatewayRuntimeArtifactOperations:
    def __init__(self, client: "GatewayRuntimeClient") -> None:
        self._client = client

    async def read(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        validated_request = PORTABLE_CONTRACT_ADAPTERS["portal.artifact.read-request"].validate_python(request)
        if not isinstance(validated_request, BaseModel):
            error_message = "Artifact read request did not produce a typed model."
            raise TypeError(error_message)
        response = await self._client.request(
            "artifact.read",
            {
                "publicRequest": validated_request.model_dump(by_alias=True, mode="json", exclude_none=True),
                "trustedContext": _validate_trusted_invocation_context(trusted_context),
            },
        )
        validated_result = PORTABLE_CONTRACT_ADAPTERS["portal.artifact.read-result"].validate_python(response)
        if not isinstance(validated_result, BaseModel):
            error_message = "Artifact read result did not produce a typed model."
            raise TypeError(error_message)
        return validated_result


class GatewayRuntimeClient:
    """One lifecycle-fenced rich client for the current framework attachment."""

    def __init__(  # noqa: PLR0913
        self,
        *,
        attachment: Mapping[str, object],
        startup_retry_policy: GatewayRuntimeStartupRetryPolicy | Mapping[str, object] | None = None,
        startup_retry_scheduler: GatewayRuntimeStartupRetryScheduler | None = None,
        trace_context_provider: GatewayRuntimeTraceContextProvider | None = None,
        transport: GatewayRuntimeTransport | None = None,
        socket_path: str = DEFAULT_GATEWAY_RUNTIME_SOCKET_PATH,
    ) -> None:
        self._attachment = _validate_attachment(attachment)
        self._transport = transport if transport is not None else GatewayRuntimeUdsTransport()
        self._trace_context_provider = trace_context_provider
        self._socket_path = socket_path
        try:
            self._startup_retry_policy = (
                DEFAULT_GATEWAY_RUNTIME_STARTUP_RETRY_POLICY
                if startup_retry_policy is None
                else GatewayRuntimeStartupRetryPolicy.model_validate(startup_retry_policy)
            )
        except ValidationError as error:
            raise GatewayRuntimeClientError(
                "invalid-startup-retry-policy",
                "Gateway runtime startup retry policy must contain bounded positive integers.",
            ) from error
        self._startup_retry_scheduler = DEFAULT_GATEWAY_RUNTIME_STARTUP_RETRY_SCHEDULER if startup_retry_scheduler is None else startup_retry_scheduler
        self._connected = False
        self._lifecycle_lock = asyncio.Lock()
        self.artifacts = _GatewayRuntimeArtifactOperations(self)
        self.portal = _GatewayRuntimePortalOperations(self)
        self.sandbox = GatewayRuntimeSandboxOperations(self)

    async def connect(self) -> None:
        async with self._lifecycle_lock:
            await self._connect_without_lifecycle_lock(retry_prepublication=True)

    async def _connect_without_lifecycle_lock(self, *, retry_prepublication: bool) -> None:
        if self._connected:
            error_code = "already-connected"
            error_message = "Gateway runtime client already has an active attachment."
            raise GatewayRuntimeClientError(
                error_code,
                error_message,
            )
        policy = self._startup_retry_policy
        retry_scheduler = self._startup_retry_scheduler
        attempts = 0
        last_unavailable_error: GatewayRuntimeStartupUnavailableError | None = None
        deadline_at_milliseconds = retry_scheduler.now_milliseconds() + policy.deadline_milliseconds
        startup_timeout = asyncio.timeout(policy.deadline_milliseconds / 1_000)
        try:
            async with startup_timeout:
                while True:
                    attempts += 1
                    try:
                        await self._transport.connect(self._socket_path)
                    except (ConnectionRefusedError, FileNotFoundError) as error:
                        last_unavailable_error = GatewayRuntimeStartupUnavailableError(
                            "socket-absent" if isinstance(error, FileNotFoundError) else "socket-refused",
                            cause=error,
                        )
                        if not retry_prepublication:
                            raise last_unavailable_error from error
                        remaining_milliseconds = deadline_at_milliseconds - retry_scheduler.now_milliseconds()
                        if attempts >= policy.maximum_attempts or remaining_milliseconds <= 0:
                            raise GatewayRuntimeStartupRetryExhaustedError(
                                attempts=attempts,
                            ) from last_unavailable_error
                        await retry_scheduler.wait(
                            min(policy.interval_milliseconds, remaining_milliseconds),
                        )
                        if retry_scheduler.now_milliseconds() >= deadline_at_milliseconds:
                            raise GatewayRuntimeStartupRetryExhaustedError(
                                attempts=attempts,
                            ) from last_unavailable_error
                        continue
                    try:
                        decision = await self._transport.handshake(self._attachment)
                    except BaseException:
                        await self._transport.disconnect()
                        raise
                    if decision.get("kind") != "accepted":
                        await self._transport.disconnect()
                        rejection_code = decision.get("code")
                        raise GatewayRuntimeClientError(
                            rejection_code if isinstance(rejection_code, str) else "invalid-handshake",
                            "Gateway runtime rejected the managed-plugin attachment.",
                        )
                    self._connected = True
                    return
        except TimeoutError as error:
            if not startup_timeout.expired():
                raise
            await self._transport.disconnect()
            raise GatewayRuntimeStartupRetryExhaustedError(
                attempts=attempts,
            ) from (last_unavailable_error or error)

    async def reconnect(self) -> None:
        async with self._lifecycle_lock:
            await self._disconnect_without_lifecycle_lock()
            await self._connect_without_lifecycle_lock(retry_prepublication=False)

    async def disconnect(self) -> None:
        async with self._lifecycle_lock:
            await self._disconnect_without_lifecycle_lock()

    async def _disconnect_without_lifecycle_lock(self) -> None:
        self._connected = False
        await self._transport.disconnect()

    async def request(
        self,
        method: str,
        params: Mapping[str, object],
    ) -> Mapping[str, object]:
        if not self._connected:
            error_code = "handshake-required"
            error_message = "Gateway runtime handshake must complete before method calls."
            raise GatewayRuntimeClientError(
                error_code,
                error_message,
            )
        provided_trace_context = self._trace_context_provider() if self._trace_context_provider is not None else None
        request_params = params if provided_trace_context is None else {**params, "traceContext": _validate_trace_context(provided_trace_context)}
        response = await self._transport.request(method, request_params)
        if response.get("kind") == "rejected":
            rejection_code = response.get("code")
            raise GatewayRuntimeClientError(
                rejection_code if isinstance(rejection_code, str) else "request-rejected",
                str(response.get("message", "Gateway runtime request was rejected.")),
            )
        return response
