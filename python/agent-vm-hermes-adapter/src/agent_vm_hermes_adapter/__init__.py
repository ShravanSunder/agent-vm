"""Managed Hermes Gateway Runtime adapter."""

from .managed_gateway_bootstrap import (
    HermesManagedEnvironmentHooks,
    load_managed_adapter_material,
    run_managed_hermes_gateway,
)
from .managed_gateway_runtime_environment import (
    HermesGatewayRuntimeEnvironment,
    HermesGatewayRuntimeEnvironmentFactory,
    HermesGatewayRuntimeOutcomeError,
)
from .managed_profile_adapter import (
    CanonicalManagedAgentProjection,
    HermesManagedAdapter,
    HermesManagedAdapterConfig,
    HermesProfileAdmissionError,
)

__all__ = (
    "CanonicalManagedAgentProjection",
    "HermesManagedAdapter",
    "HermesManagedAdapterConfig",
    "HermesProfileAdmissionError",
    "HermesGatewayRuntimeEnvironment",
    "HermesGatewayRuntimeEnvironmentFactory",
    "HermesGatewayRuntimeOutcomeError",
    "HermesManagedEnvironmentHooks",
    "load_managed_adapter_material",
    "run_managed_hermes_gateway",
)
